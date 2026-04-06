"""Lite Monte Carlo prediction engine — 100K sims, sentiment-adjusted."""
import csv
import json
import random
import os
import logging
from datetime import datetime, timedelta, timezone

from config import (
    RESULTS_2021_CSV, RESULTS_2016_CSV, LSG_SWING_CSV, CANDIDATES_CSV,
    PREDICTIONS_BASE, PREDICTIONS_LIVE_FILE, TRENDS_FILE,
    LITE_SIMULATIONS, AGGREGATE_SIMULATIONS,
    SWING_DAMPENING, VOLATILITY_BASE, VOLATILITY_MARGIN_FACTOR,
    MAX_SENTIMENT_ADJUSTMENT, LIVE_DATA_DIR,
)

logger = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))

LDF_2016 = {"CPM", "CPI", "JD(S)", "NCP", "RSP", "INL", "CMPKSC", "KEC(B)", "Congress(S)", "NSC"}
UDF_2016 = {"INC", "IUML", "KEC(M)", "KEC(J)", "JD(U)", "KEC"}


class LiteMonteCarlo:
    def __init__(self):
        self.results_2021: dict = {}
        self.results_2016: dict = {}
        self.lsg_swing: dict = {}
        self.candidates: dict = {}
        self.district_map: dict = {}
        self.base_predictions: list[dict] = []

    def load_base_data(self):
        # District map
        with open(CANDIDATES_CSV, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                cno = int(row["Constituency_No"])
                self.district_map[cno] = row["District"]
                self.candidates[cno] = row

        # 2021 results
        with open(RESULTS_2021_CSV, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                cno = int(row["Constituency_No"])
                self.results_2021[cno] = {
                    "name": row["Constituency"],
                    "ldf_vs": float(row["LDF_VoteShare"]),
                    "udf_vs": float(row["UDF_VoteShare"]),
                    "nda_vs": float(row["NDA_VoteShare"]),
                    "winner_front": row["Winner_Front"],
                    "margin": int(row["Margin"]),
                    "total_votes": int(row["Total_Votes"]),
                }

        # 2016 results
        with open(RESULTS_2016_CSV, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                cno = int(row["Constituency_No"])
                self.results_2016[cno] = {
                    "winner_party": row["Winner_Party"],
                    "runner_up_party": row["Runner_Up_Party"],
                }

        # LSG swing
        with open(LSG_SWING_CSV, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                self.lsg_swing[row["District"]] = {
                    "ldf": float(row["LDF_Swing"]),
                    "udf": float(row["UDF_Swing"]),
                    "nda": float(row["NDA_Swing"]),
                }

        # Base predictions for comparison
        if os.path.exists(PREDICTIONS_BASE):
            with open(PREDICTIONS_BASE, encoding="utf-8") as f:
                self.base_predictions = json.load(f)

        logger.info(f"Loaded base data: {len(self.results_2021)} constituencies")

    def run_simulation(self, sentiment_adj: dict) -> tuple[list[dict], dict]:
        # Clamp sentiment adjustments
        for front in sentiment_adj:
            sentiment_adj[front] = max(-MAX_SENTIMENT_ADJUSTMENT,
                                       min(MAX_SENTIMENT_ADJUSTMENT, sentiment_adj[front]))

        output = []
        random.seed()  # Fresh seed each run for variety

        for cno in range(1, 141):
            r21 = self.results_2021.get(cno)
            if not r21:
                continue

            district = self.district_map.get(cno, "")
            swing = self.lsg_swing.get(district, {"ldf": 0, "udf": 0, "nda": 0})
            cand = self.candidates.get(cno, {})

            # Base vote shares
            base_ldf = r21["ldf_vs"]
            base_udf = r21["udf_vs"]
            base_nda = r21["nda_vs"]
            base_oth = 100 - base_ldf - base_udf - base_nda

            # Apply dampened LSG swing + sentiment
            adj_ldf = base_ldf + swing["ldf"] * SWING_DAMPENING + sentiment_adj.get("LDF", 0)
            adj_udf = base_udf + swing["udf"] * SWING_DAMPENING + sentiment_adj.get("UDF", 0)
            adj_nda = base_nda + swing["nda"] * SWING_DAMPENING + sentiment_adj.get("NDA", 0)

            # Normalize
            adj_ldf = max(adj_ldf, 2)
            adj_udf = max(adj_udf, 2)
            adj_nda = max(adj_nda, 2)
            total_adj = adj_ldf + adj_udf + adj_nda + base_oth
            adj_ldf = adj_ldf / total_adj * 100
            adj_udf = adj_udf / total_adj * 100
            adj_nda = adj_nda / total_adj * 100

            # Volatility
            margin_pct = r21["margin"] / r21["total_votes"] * 100
            volatility = VOLATILITY_BASE + VOLATILITY_MARGIN_FACTOR * (30 - min(margin_pct, 30))

            r16 = self.results_2016.get(cno)
            if r16:
                if r16["winner_party"] in UDF_2016 and r21["winner_front"] == "LDF":
                    volatility += 1.0
                elif r16["winner_party"] in LDF_2016 and r21["winner_front"] == "UDF":
                    volatility += 1.0

            # Monte Carlo
            wins = {"LDF": 0, "UDF": 0, "NDA": 0}
            for _ in range(LITE_SIMULATIONS):
                sim_ldf = random.gauss(adj_ldf, volatility)
                sim_udf = random.gauss(adj_udf, volatility)
                sim_nda = random.gauss(adj_nda, volatility * 0.7)

                if sim_ldf >= sim_udf and sim_ldf >= sim_nda:
                    wins["LDF"] += 1
                elif sim_udf >= sim_ldf and sim_udf >= sim_nda:
                    wins["UDF"] += 1
                else:
                    wins["NDA"] += 1

            ldf_prob = wins["LDF"] / LITE_SIMULATIONS * 100
            udf_prob = wins["UDF"] / LITE_SIMULATIONS * 100
            nda_prob = wins["NDA"] / LITE_SIMULATIONS * 100

            max_prob = max(ldf_prob, udf_prob, nda_prob)
            if max_prob >= 90:
                cat = "Safe"
            elif max_prob >= 70:
                cat = "Likely"
            elif max_prob >= 55:
                cat = "Lean"
            else:
                cat = "Toss-up"

            predicted_winner = max(wins, key=wins.get)
            category = f"{cat} {predicted_winner}"

            output.append({
                "Constituency_No": cno,
                "Constituency": r21["name"],
                "District": district,
                "LDF_Candidate": cand.get("LDF_Candidate", ""),
                "LDF_Party": cand.get("LDF_Party", ""),
                "UDF_Candidate": cand.get("UDF_Candidate", ""),
                "UDF_Party": cand.get("UDF_Party", ""),
                "NDA_Candidate": cand.get("NDA_Candidate", ""),
                "NDA_Party": cand.get("NDA_Party", ""),
                "Base_LDF": round(base_ldf, 2),
                "Base_UDF": round(base_udf, 2),
                "Base_NDA": round(base_nda, 2),
                "Adjusted_LDF": round(adj_ldf, 2),
                "Adjusted_UDF": round(adj_udf, 2),
                "Adjusted_NDA": round(adj_nda, 2),
                "LDF_Win_Prob": round(ldf_prob, 2),
                "UDF_Win_Prob": round(udf_prob, 2),
                "NDA_Win_Prob": round(nda_prob, 2),
                "Category": category,
                "Margin_2021": r21["margin"],
                "Winner_2021": r21["winner_front"],
                "Volatility": round(volatility, 2),
                "Sentiment_Applied": {k: round(v, 3) for k, v in sentiment_adj.items()},
            })

        # Aggregate seat projections
        seat_counts = {"LDF": [], "UDF": [], "NDA": []}
        for _ in range(AGGREGATE_SIMULATIONS):
            seats = {"LDF": 0, "UDF": 0, "NDA": 0}
            for o in output:
                r = random.random() * 100
                if r < o["LDF_Win_Prob"]:
                    seats["LDF"] += 1
                elif r < o["LDF_Win_Prob"] + o["UDF_Win_Prob"]:
                    seats["UDF"] += 1
                else:
                    seats["NDA"] += 1
            for front in seats:
                seat_counts[front].append(seats[front])

        def pct(data, p):
            s = sorted(data)
            idx = int(len(s) * p / 100)
            return s[min(idx, len(s) - 1)]

        summary = {}
        for front in ["LDF", "UDF", "NDA"]:
            vals = seat_counts[front]
            summary[front] = {
                "mean": round(sum(vals) / len(vals), 1),
                "median": pct(vals, 50),
                "p5": pct(vals, 5),
                "p25": pct(vals, 25),
                "p75": pct(vals, 75),
                "p95": pct(vals, 95),
                "min": min(vals),
                "max": max(vals),
            }

        # Categories
        categories = {}
        for o in output:
            cat = o["Category"]
            categories[cat] = categories.get(cat, 0) + 1

        full_summary = {
            "seat_projections": summary,
            "categories": categories,
            "config": {
                "num_simulations": LITE_SIMULATIONS,
                "swing_dampening": SWING_DAMPENING,
                "sentiment_applied": sentiment_adj,
            },
        }

        return output, full_summary

    def identify_hot_constituencies(self, live: list[dict]) -> list[dict]:
        if not self.base_predictions:
            return []

        base_map = {b["Constituency_No"]: b for b in self.base_predictions}
        changes = []
        for item in live:
            cno = item["Constituency_No"]
            base = base_map.get(cno)
            if not base:
                continue

            max_delta = 0
            change_detail = ""
            for front in ["LDF", "UDF", "NDA"]:
                delta = item[f"{front}_Win_Prob"] - base[f"{front}_Win_Prob"]
                if abs(delta) > abs(max_delta):
                    max_delta = delta
                    sign = "+" if delta > 0 else ""
                    change_detail = f"{front} {sign}{delta:.1f}%"

            changes.append({
                "no": cno,
                "name": item["Constituency"],
                "change": change_detail,
                "delta": abs(max_delta),
                "category": item["Category"],
            })

        changes.sort(key=lambda x: x["delta"], reverse=True)
        return changes[:5]

    def save_and_trend(self, predictions: list[dict], summary: dict, hot: list[dict]):
        os.makedirs(LIVE_DATA_DIR, exist_ok=True)

        # Save predictions
        live_output = {
            "last_updated": datetime.now(IST).isoformat(),
            "predictions": predictions,
            "summary": summary,
        }
        with open(PREDICTIONS_LIVE_FILE, "w", encoding="utf-8") as f:
            json.dump(live_output, f, ensure_ascii=False, indent=2)

        # Append to trends
        trends = {"updates": []}
        if os.path.exists(TRENDS_FILE):
            with open(TRENDS_FILE, encoding="utf-8") as f:
                trends = json.load(f)

        trends["updates"].append({
            "timestamp": datetime.now(IST).isoformat(),
            "seat_projections": summary["seat_projections"],
            "sentiment_applied": summary["config"].get("sentiment_applied", {}),
            "hot_constituencies": hot,
        })

        # Keep last 168 updates (7 days hourly)
        trends["updates"] = trends["updates"][-168:]

        with open(TRENDS_FILE, "w", encoding="utf-8") as f:
            json.dump(trends, f, ensure_ascii=False, indent=2)

        sp = summary["seat_projections"]
        logger.info(
            f"Predictions updated: LDF {sp['LDF']['median']} [{sp['LDF']['p5']}-{sp['LDF']['p95']}] | "
            f"UDF {sp['UDF']['median']} [{sp['UDF']['p5']}-{sp['UDF']['p95']}] | "
            f"NDA {sp['NDA']['median']} [{sp['NDA']['p5']}-{sp['NDA']['p95']}]"
        )
