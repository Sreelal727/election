"""Keyword-based sentiment engine for Kerala election news."""
import json
import math
import os
import logging
from datetime import datetime, timedelta, timezone
from collections import defaultdict

from config import (
    ENGLISH_KEYWORDS_FILE, MALAYALAM_KEYWORDS_FILE,
    SENTIMENT_FILE, MAX_SENTIMENT_ADJUSTMENT,
)

logger = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))


class SentimentEngine:
    def __init__(self):
        self.keywords_en: dict = {}
        self.keywords_ml: dict = {}

    def load_keywords(self):
        if os.path.exists(ENGLISH_KEYWORDS_FILE):
            with open(ENGLISH_KEYWORDS_FILE, encoding="utf-8") as f:
                self.keywords_en = json.load(f)
        if os.path.exists(MALAYALAM_KEYWORDS_FILE):
            with open(MALAYALAM_KEYWORDS_FILE, encoding="utf-8") as f:
                self.keywords_ml = json.load(f)

    def _match_count(self, text: str, keywords: list[str], case_sensitive: bool = False) -> tuple[int, list[str]]:
        matched = []
        if not case_sensitive:
            text = text.lower()
            for kw in keywords:
                if kw.lower() in text:
                    matched.append(kw)
        else:
            for kw in keywords:
                if kw in text:
                    matched.append(kw)
        return len(matched), matched

    def classify_article(self, article: dict) -> dict:
        text = f"{article.get('title', '')} {article.get('summary', '')}"
        lang = article.get("lang", "en")

        kw_source = self.keywords_ml if lang == "ml" else self.keywords_en
        is_malayalam = lang == "ml"

        scores = {}
        all_matched = []

        for front in ["LDF", "UDF", "NDA"]:
            net = 0
            pro_strong = kw_source.get(f"pro_{front}", {}).get("strong", [])
            pro_mod = kw_source.get(f"pro_{front}", {}).get("moderate", [])
            anti_strong = kw_source.get(f"anti_{front}", {}).get("strong", [])
            anti_mod = kw_source.get(f"anti_{front}", {}).get("moderate", [])

            c, m = self._match_count(text, pro_strong, case_sensitive=is_malayalam)
            net += c * 2
            all_matched.extend(m)

            c, m = self._match_count(text, pro_mod, case_sensitive=is_malayalam)
            net += c * 1
            all_matched.extend(m)

            c, m = self._match_count(text, anti_strong, case_sensitive=is_malayalam)
            net -= c * 2
            all_matched.extend(m)

            c, m = self._match_count(text, anti_mod, case_sensitive=is_malayalam)
            net -= c * 1
            all_matched.extend(m)

            # Also check English keywords for Malayalam articles (Manglish terms)
            if is_malayalam and self.keywords_en:
                for key in [f"pro_{front}", f"anti_{front}"]:
                    for strength in ["strong", "moderate"]:
                        kws = self.keywords_en.get(key, {}).get(strength, [])
                        weight = 2 if strength == "strong" else 1
                        sign = 1 if key.startswith("pro") else -1
                        c, m = self._match_count(text, kws)
                        net += c * weight * sign
                        all_matched.extend(m)

            scores[front] = math.tanh(net / 5.0)

        # Determine dominant front
        best_front = max(scores, key=lambda k: abs(scores[k]))
        best_score = scores[best_front]

        if abs(best_score) < 0.1:
            front_label = "neutral"
            direction = "neutral"
        else:
            front_label = best_front
            direction = "pro" if best_score > 0 else "anti"

        # Deduplicate matched keywords
        unique_matched = list(dict.fromkeys(all_matched))

        return {
            "front": front_label,
            "direction": direction,
            "score": round(best_score, 3),
            "scores": {k: round(v, 3) for k, v in scores.items()},
            "matched_keywords": unique_matched[:10],
        }

    def classify_all(self, articles: list[dict]) -> list[dict]:
        for article in articles:
            if article.get("sentiment") is None:
                article["sentiment"] = self.classify_article(article)
        return articles

    def compute_hourly_trend(self, articles: list[dict]) -> dict:
        now = datetime.now(IST)
        hourly_buckets = defaultdict(lambda: defaultdict(lambda: {"scores": [], "count": 0}))

        for article in articles:
            sent = article.get("sentiment")
            if not sent or not sent.get("scores"):
                continue

            try:
                pub = datetime.fromisoformat(article["published"])
            except (ValueError, KeyError):
                continue

            age_hours = (now - pub).total_seconds() / 3600
            if age_hours > 24:
                continue

            hour_key = pub.strftime("%Y-%m-%dT%H:00")
            for front in ["LDF", "UDF", "NDA"]:
                score = sent["scores"].get(front, 0)
                hourly_buckets[hour_key][front]["scores"].append(score)
                hourly_buckets[hour_key][front]["count"] += 1

        # Build hourly array (last 24 hours)
        hourly = []
        for i in range(24):
            h = now - timedelta(hours=23 - i)
            hour_key = h.strftime("%Y-%m-%dT%H:00")
            entry = {"hour": hour_key}
            for front in ["LDF", "UDF", "NDA"]:
                bucket = hourly_buckets.get(hour_key, {}).get(front, {"scores": [], "count": 0})
                scores = bucket["scores"]
                avg = sum(scores) / len(scores) if scores else 0
                entry[front] = {"score": round(avg, 3), "count": bucket["count"]}
            hourly.append(entry)

        # Current scores (latest hour with data)
        current_scores = {"LDF": 0, "UDF": 0, "NDA": 0}
        for entry in reversed(hourly):
            has_data = any(entry[f]["count"] > 0 for f in ["LDF", "UDF", "NDA"])
            if has_data:
                current_scores = {f: entry[f]["score"] for f in ["LDF", "UDF", "NDA"]}
                break

        # Momentum: slope of last 6 hours
        momentum = {}
        for front in ["LDF", "UDF", "NDA"]:
            recent = [e[front]["score"] for e in hourly[-6:] if e[front]["count"] > 0]
            if len(recent) >= 2:
                slope = (recent[-1] - recent[0]) / len(recent)
                if slope > 0.05:
                    momentum[front] = "up"
                elif slope < -0.05:
                    momentum[front] = "down"
                else:
                    momentum[front] = "stable"
            else:
                momentum[front] = "stable"

        # Article counts by front
        counts = defaultdict(int)
        for article in articles:
            sent = article.get("sentiment")
            if sent:
                counts[sent.get("front", "neutral")] += 1

        result = {
            "last_updated": now.isoformat(),
            "current_scores": current_scores,
            "momentum": momentum,
            "hourly": hourly,
            "front_article_counts": dict(counts),
        }

        os.makedirs(os.path.dirname(SENTIMENT_FILE), exist_ok=True)
        with open(SENTIMENT_FILE, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        logger.info(f"Sentiment: LDF={current_scores['LDF']:.2f} UDF={current_scores['UDF']:.2f} NDA={current_scores['NDA']:.2f} | Momentum: {momentum}")
        return result

    def get_sentiment_adjustment(self) -> dict:
        if not os.path.exists(SENTIMENT_FILE):
            return {"LDF": 0, "UDF": 0, "NDA": 0}

        with open(SENTIMENT_FILE, encoding="utf-8") as f:
            data = json.load(f)

        scores = data.get("current_scores", {"LDF": 0, "UDF": 0, "NDA": 0})
        counts = data.get("front_article_counts", {})

        # Front-specific weights based on Kochi ground reality:
        # - UDF is the primary beneficiary of anti-incumbency + media coverage
        # - LDF gets moderate lift (they have organized media presence)
        # - NDA gets minimal — their support is community-based, not media-driven
        # - Article volume matters: more mentions = more impact
        total_articles = max(sum(counts.get(f, 0) for f in ["LDF", "UDF", "NDA"]), 1)
        udf_share = counts.get("UDF", 0) / total_articles
        ldf_share = counts.get("LDF", 0) / total_articles
        nda_share = counts.get("NDA", 0) / total_articles

        # Base weights: UDF amplified, NDA suppressed
        FRONT_WEIGHTS = {"UDF": 1.6, "LDF": 0.8, "NDA": 0.25}

        adj = {}
        for front in ["LDF", "UDF", "NDA"]:
            raw = scores.get(front, 0)
            weight = FRONT_WEIGHTS[front]
            # Boost further if this front has higher article share
            share = {"UDF": udf_share, "LDF": ldf_share, "NDA": nda_share}[front]
            volume_boost = 1.0 + share * 0.5  # up to +50% boost for dominant front
            adj[front] = round(raw * MAX_SENTIMENT_ADJUSTMENT * weight * volume_boost, 3)
            # Clamp
            adj[front] = max(-MAX_SENTIMENT_ADJUSTMENT, min(MAX_SENTIMENT_ADJUSTMENT, adj[front]))

        return adj
