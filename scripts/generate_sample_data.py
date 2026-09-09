"""
generate_sample_data.py

Writes a small SAMPLE/PLACEHOLDER docs/data/players.json so the site
has something to render immediately after cloning, before you've run
the real pipeline (fetch_data.py, or the GitHub Action) even once.

These are synthetic tiers (elite/mid/replacement), not real player
stats — do not mistake them for a live projection. Run fetch_data.py
(locally or via the Action) to replace this with real nflverse data.
"""

import json
import random
from pathlib import Path

random.seed(7)

OUT_PATH = Path(__file__).resolve().parent.parent / "docs" / "data" / "players.json"

TEAMS = ["BUF", "MIA", "NE", "NYJ", "BAL", "CIN", "CLE", "PIT", "HOU", "IND",
         "JAX", "TEN", "DEN", "KC", "LV", "LAC", "DAL", "NYG", "PHI", "WSH",
         "CHI", "DET", "GB", "MIN", "ATL", "CAR", "NO", "TB", "ARI", "LAR",
         "SF", "SEA"]

TIERS = {
    "QB": [("elite", 3), ("mid", 4), ("replacement", 3)],
    "RB": [("elite", 4), ("mid", 6), ("replacement", 6)],
    "WR": [("elite", 5), ("mid", 8), ("replacement", 8)],
    "TE": [("elite", 3), ("mid", 5), ("replacement", 4)],
}

FIRST = ["Alex", "Jordan", "Marcus", "Devon", "Jalen", "Chris", "Tyler", "Cam",
         "Miles", "Deion", "Trevor", "Xavier", "Brandon", "Elijah", "Aiden", "Rashad"]
LAST = ["Harper", "Coleman", "Reyes", "Whitfield", "Grant", "Sutton", "Marsh",
        "Odom", "Kellerman", "Vance", "Rourke", "Delgado", "Priest", "Sawyer"]


def make_schedule():
    sched = {}
    bye_week = random.randint(6, 14)
    for wk in range(1, 19):
        if wk == bye_week:
            continue
        sched[str(wk)] = {"opp": random.choice(TEAMS), "home": random.random() > 0.5}
    return sched


def negbin(mean, var):
    if var <= mean:
        var = mean * 1.15
    p = mean / var
    r = mean * p / (1 - p)
    return {"r": round(max(r, 0.5), 3), "p": round(min(max(p, 0.01), 0.99), 4)}


def make_skill_player(name, pos, team, tier):
    scale = {"elite": 1.4, "mid": 1.0, "replacement": 0.6}[tier]
    carries_mean = (14 if pos == "RB" else 1.5) * scale
    targets_mean = (4 if pos == "RB" else 8 if pos == "WR" else 6) * scale

    return {
        "id": f"sample-{name}",
        "name": name,
        "position": pos,
        "team": team,
        "games_sampled": 24,
        "volume": {
            "carries": negbin(carries_mean, carries_mean * 2.2),
            "targets": negbin(targets_mean, targets_mean * 1.8),
        },
        "efficiency": {
            "ypc": {"mean": round(random.uniform(3.8, 5.2), 2), "std": 1.4},
            "catch_rate": round(random.uniform(0.58, 0.78), 2),
            "ypr": {"mean": round(random.uniform(8.5, 13.5), 2), "std": 3.2},
        },
        "td_rate": {
            "rush_td_per_carry": round(0.02 * scale, 4),
            "rec_td_per_catch": round(0.06 * scale, 4),
            "fumble_rate": 0.04,
        },
        "schedule": make_schedule(),
        "expert_rank": None,
    }


def make_qb(name, team, tier):
    scale = {"elite": 1.25, "mid": 1.0, "replacement": 0.8}[tier]
    return {
        "id": f"sample-{name}",
        "name": name,
        "position": "QB",
        "team": team,
        "games_sampled": 24,
        "volume": {"attempts": negbin(34 * scale, 34 * 3.0)},
        "efficiency": {
            "comp_pct": {"mean": round(random.uniform(0.6, 0.7), 3), "std": 0.05},
            "yards_per_attempt": {"mean": round(random.uniform(6.6, 8.2) * scale, 2), "std": 1.1},
        },
        "td_rate": {
            "pass_td_per_att": round(0.05 * scale, 4),
            "int_per_att": round(0.025 / scale, 4),
        },
        "rushing": {
            "volume": negbin(3.5 * scale, 3.5 * 2.5),
            "ypc": round(random.uniform(3.5, 6.5), 2),
            "td_per_carry": round(0.05 * scale, 4),
        },
        "schedule": make_schedule(),
        "expert_rank": None,
    }


def main():
    used_names = set()

    def unique_name():
        while True:
            n = f"{random.choice(FIRST)} {random.choice(LAST)}"
            if n not in used_names:
                used_names.add(n)
                return n

    players = []
    for pos, tiers in TIERS.items():
        rank_counter = 1
        for tier, count in tiers:
            for _ in range(count):
                name = unique_name()
                team = random.choice(TEAMS)
                if pos == "QB":
                    p = make_qb(name, team, tier)
                else:
                    p = make_skill_player(name, pos, team, tier)
                p["expert_rank"] = rank_counter
                rank_counter += 1
                players.append(p)

    out = {
        "generated_at": "SAMPLE-DATA-NOT-LIVE",
        "season": "sample",
        "history_seasons": [],
        "players": players,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2)
    print(f"Wrote {len(players)} sample players to {OUT_PATH}")


if __name__ == "__main__":
    main()
