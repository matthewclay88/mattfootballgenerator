"""
fetch_data.py

Pulls player stats from nflverse (nfl_data_py), pulls Expert
Consensus Rankings from the official FantasyPros API, computes
per-player Monte-Carlo simulation parameters, and writes everything
to docs/data/players.json for the static front end to consume.

This is meant to be run by the GitHub Action on a schedule (see
.github/workflows/update-data.yml), but you can also run it locally:

    export FANTASYPROS_API_KEY=your_key_here
    pip install -r scripts/requirements.txt
    python scripts/fetch_data.py

A FantasyPros API key is free for personal/prototype use - request
one at https://secure.fantasypros.com/api-keys/request. Without a
key set, this script still runs fine; it just skips the expert-rank
enrichment step (players sort alphabetically instead).
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

try:
    import nfl_data_py as nfl
except ImportError:
    print("nfl_data_py is required: pip install -r scripts/requirements.txt")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "docs" / "data" / "players.json"

# How many completed seasons of weekly logs to use for fitting each
# player's distribution. Two years balances sample size against a
# player's stats reflecting their *current* role.
CURRENT_SEASON = 2026
HISTORY_SEASONS = [CURRENT_SEASON - 2, CURRENT_SEASON - 1]

OFFENSE_POSITIONS = {"QB", "RB", "WR", "TE"}

FANTASYPROS_API_KEY = os.environ.get("FANTASYPROS_API_KEY", "")
FANTASYPROS_BASE = "https://api.fantasypros.com/public/v2/json"
# FantasyPros scoring-format query values, and the format keys we
# store per player so the site can show a rank per scoring format.
FANTASYPROS_SCORINGS = {"STD": "standard", "HALF": "half", "PPR": "ppr"}


def normalize_name(name):
    """Loosely normalize a player name for cross-source matching
    (nflverse vs. FantasyPros spell/punctuate names slightly
    differently sometimes - e.g. 'Gabe Davis' vs 'Gabriel Davis',
    suffixes, periods)."""
    name = name.lower()
    name = re.sub(r"[.']", "", name)
    name = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", name)
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def fetch_weekly_logs():
    """Pull weekly player-level stats for the history window."""
    cols = [
        "player_id", "player_name", "player_display_name", "position",
        "recent_team", "season", "week",
        "carries", "rushing_yards", "rushing_tds",
        "targets", "receptions", "receiving_yards", "receiving_tds",
        "attempts", "completions", "passing_yards", "passing_tds",
        "interceptions", "sacks", "rushing_fumbles_lost",
        "receiving_fumbles_lost", "sack_fumbles_lost",
    ]
    df = nfl.import_weekly_data(HISTORY_SEASONS, downcast=True)
    available = [c for c in cols if c in df.columns]
    df = df[available]
    df = df[df["position"].isin(OFFENSE_POSITIONS)]
    return df


def fetch_schedule():
    """Pull the current season's schedule so we know each team's
    week-by-week opponent and bye week."""
    try:
        sched = nfl.import_schedules([CURRENT_SEASON])
    except Exception as exc:  # noqa: BLE001 - best effort, non-fatal
        print(f"Could not pull schedule for {CURRENT_SEASON}: {exc}")
        return {}

    team_weeks = {}
    for _, row in sched.iterrows():
        week = int(row["week"])
        home, away = row["home_team"], row["away_team"]
        team_weeks.setdefault(home, {})[week] = {"opp": away, "home": True}
        team_weeks.setdefault(away, {})[week] = {"opp": home, "home": False}
    return team_weeks


def fetch_fantasypros_rankings():
    """Pull Expert Consensus Rankings (ECR) from the official
    FantasyPros API - https://www.fantasypros.com/api-data/ - for
    each offensive position and each scoring format.

    Requires FANTASYPROS_API_KEY (free for personal/prototype use:
    https://secure.fantasypros.com/api-keys/request). Returns {} on
    any failure - including a missing key - so the rest of the
    pipeline still succeeds; players just fall back to alphabetical
    sort in the UI.

    Returns: dict keyed by normalize_name(player) ->
        {"team": str, "ranks": {"standard": int, "half": int, "ppr": int},
         "tier": {"standard": int, ...}}
    """
    if not FANTASYPROS_API_KEY:
        print("  no FANTASYPROS_API_KEY set - skipping expert rankings")
        return {}

    headers = {"x-api-key": FANTASYPROS_API_KEY}
    out = {}

    for position in sorted(OFFENSE_POSITIONS):
        for fp_scoring, our_key in FANTASYPROS_SCORINGS.items():
            url = f"{FANTASYPROS_BASE}/nfl/{CURRENT_SEASON}/consensus-rankings"
            params = {"position": position, "scoring": fp_scoring, "type": "ST"}
            try:
                resp = requests.get(url, headers=headers, params=params, timeout=20)
                resp.raise_for_status()
                data = resp.json()
            except Exception as exc:  # noqa: BLE001 - best effort, non-fatal
                print(f"  FantasyPros pull failed for {position}/{fp_scoring} (non-fatal): {exc}")
                continue

            for p in data.get("players", []):
                name = p.get("player_name")
                if not name:
                    continue
                key = normalize_name(name)
                entry = out.setdefault(key, {"team": p.get("player_team_id"), "ranks": {}, "tier": {}})
                rank = p.get("rank_ecr") or p.get("pos_rank")
                if rank is not None:
                    entry["ranks"][our_key] = int(rank)
                if p.get("tier") is not None:
                    entry["tier"][our_key] = int(p["tier"])
            time.sleep(0.2)  # be polite to the free tier's rate limit

    print(f"  matched {len(out)} FantasyPros player entries")
    return out


def negbin_params(mean, var):
    """Method-of-moments fit for a Negative Binomial(r, p), used for
    count stats (carries, targets, attempts) which are typically
    overdispersed relative to a Poisson. Falls back to a
    near-Poisson shape if variance <= mean (guards against
    division-by-zero / invalid params)."""
    if mean <= 0:
        return {"r": 1.0, "p": 0.999}
    if var <= mean:
        var = mean * 1.15  # small manufactured overdispersion floor
    p = mean / var
    r = mean * p / (1 - p)
    return {"r": max(r, 0.5), "p": min(max(p, 0.01), 0.99)}


def build_player_params(df):
    """Collapse weekly logs into per-player distribution parameters."""
    players = {}
    grouped = df.groupby(["player_id", "player_display_name", "position", "recent_team"])

    for (pid, name, pos, team), g in grouped:
        g = g.sort_values(["season", "week"])
        if len(g) < 4:
            continue  # not enough games to fit a meaningful distribution

        entry = {
            "id": str(pid),
            "name": name,
            "position": pos,
            "team": team,
            "games_sampled": int(len(g)),
        }

        def stat(col):
            return g[col].fillna(0) if col in g.columns else pd.Series([0] * len(g))

        if pos == "QB":
            att = stat("attempts")
            comp = stat("completions")
            pyds = stat("passing_yards")
            ptd = stat("passing_tds")
            ints = stat("interceptions")
            rush = stat("carries")
            ryds = stat("rushing_yards")
            rtd = stat("rushing_tds")
            entry["volume"] = {"attempts": negbin_params(att.mean(), att.var())}
            entry["efficiency"] = {
                "comp_pct": {"mean": float((comp / att.replace(0, np.nan)).mean(skipna=True) or 0.62), "std": 0.06},
                "yards_per_attempt": {"mean": float(pyds.sum() / max(att.sum(), 1)), "std": float(max((pyds / att.replace(0, np.nan)).std(skipna=True) or 1.2, 0.5))},
            }
            entry["td_rate"] = {"pass_td_per_att": float(ptd.sum() / max(att.sum(), 1)), "int_per_att": float(ints.sum() / max(att.sum(), 1))}
            entry["rushing"] = {
                "volume": negbin_params(rush.mean(), rush.var()),
                "ypc": float(ryds.sum() / max(rush.sum(), 1)),
                "td_per_carry": float(rtd.sum() / max(rush.sum(), 1)),
            }
        else:
            carries = stat("carries")
            ryds = stat("rushing_yards")
            rtd = stat("rushing_tds")
            tgt = stat("targets")
            rec = stat("receptions")
            recyds = stat("receiving_yards")
            rectd = stat("receiving_tds")
            fumbles = stat("rushing_fumbles_lost") + stat("receiving_fumbles_lost") + stat("sack_fumbles_lost")

            entry["volume"] = {
                "carries": negbin_params(carries.mean(), carries.var()),
                "targets": negbin_params(tgt.mean(), tgt.var()),
            }
            entry["efficiency"] = {
                "ypc": {"mean": float(ryds.sum() / max(carries.sum(), 1)), "std": float(max((ryds / carries.replace(0, np.nan)).std(skipna=True) or 2.0, 1.0))},
                "catch_rate": float(min(max(rec.sum() / max(tgt.sum(), 1), 0.35), 0.95)),
                "ypr": {"mean": float(recyds.sum() / max(rec.sum(), 1)), "std": float(max((recyds / rec.replace(0, np.nan)).std(skipna=True) or 4.0, 2.0))},
            }
            entry["td_rate"] = {
                "rush_td_per_carry": float(rtd.sum() / max(carries.sum(), 1)),
                "rec_td_per_catch": float(rectd.sum() / max(rec.sum(), 1)),
                "fumble_rate": float(fumbles.sum() / max(len(g), 1)),
            }

        players[name] = entry
    return players


def attach_schedule_and_rankings(players, team_weeks, fp_data):
    for name, entry in players.items():
        team = entry["team"]
        entry["schedule"] = team_weeks.get(team, {})
        fp = fp_data.get(normalize_name(name))
        if fp:
            entry["expert_ranks"] = fp.get("ranks", {})
            entry["expert_tier"] = fp.get("tier", {})
            # Single top-level "expert_rank" field the sidebar sorts
            # by; PPR is the site's default scoring format.
            entry["expert_rank"] = fp["ranks"].get("ppr") or next(iter(fp["ranks"].values()), None)
    return players


def main():
    print("Pulling weekly logs from nflverse...")
    df = fetch_weekly_logs()
    print(f"  {len(df)} player-weeks across {HISTORY_SEASONS}")

    print("Pulling schedule...")
    team_weeks = fetch_schedule()

    print("Pulling FantasyPros expert consensus rankings...")
    fp_data = fetch_fantasypros_rankings()

    print("Building per-player simulation parameters...")
    players = build_player_params(df)
    players = attach_schedule_and_rankings(players, team_weeks, fp_data)

    out = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "season": CURRENT_SEASON,
        "history_seasons": HISTORY_SEASONS,
        "players": list(players.values()),
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    print(f"Wrote {len(players)} players to {OUT_PATH}")


if __name__ == "__main__":
    main()
