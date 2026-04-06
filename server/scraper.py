"""Async RSS news scraper for Kerala election articles."""
import asyncio
import hashlib
import json
import os
import re
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import aiohttp
import certifi
import ssl
import feedparser

from config import (
    RSS_FEEDS, MAX_NEWS_ITEMS, DEDUP_HOURS,
    NEWS_FEED_FILE, ELECTION_FILTER_FILE,
)

logger = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))


class NewsScraper:
    def __init__(self):
        self.filter_keywords_en: list[str] = []
        self.filter_keywords_ml: list[str] = []
        self.seen_hashes: set[str] = set()
        self.existing_articles: list[dict] = []

    def load_keywords(self):
        with open(ELECTION_FILTER_FILE, encoding="utf-8") as f:
            data = json.load(f)
        self.filter_keywords_en = [k.lower() for k in data["english"]]
        self.filter_keywords_ml = data["malayalam"]
        self.load_existing_news()

    def load_existing_news(self):
        if os.path.exists(NEWS_FEED_FILE):
            with open(NEWS_FEED_FILE, encoding="utf-8") as f:
                data = json.load(f)
            self.existing_articles = data.get("articles", [])
            cutoff = datetime.now(IST) - timedelta(hours=DEDUP_HOURS)
            for a in self.existing_articles:
                try:
                    pub = datetime.fromisoformat(a["published"])
                    if pub > cutoff:
                        self.seen_hashes.add(a["id"])
                except (KeyError, ValueError):
                    self.seen_hashes.add(a.get("id", ""))
        else:
            self.existing_articles = []

    def _article_hash(self, title: str, url: str) -> str:
        normalized = re.sub(r"[^\w\s]", "", title.lower()).strip()
        domain = urlparse(url).netloc
        raw = f"{normalized}|{domain}"
        return hashlib.sha256(raw.encode()).hexdigest()[:12]

    def _is_election_related(self, title: str, summary: str, lang: str) -> bool:
        text = f"{title} {summary}"
        if lang == "ml":
            for kw in self.filter_keywords_ml:
                if kw in text:
                    return True
            text_lower = text.lower()
            for kw in self.filter_keywords_en:
                if kw in text_lower:
                    return True
        else:
            text_lower = text.lower()
            for kw in self.filter_keywords_en:
                if kw in text_lower:
                    return True
        return False

    def _parse_date(self, entry) -> str:
        if hasattr(entry, "published_parsed") and entry.published_parsed:
            from time import mktime
            dt = datetime.fromtimestamp(mktime(entry.published_parsed), tz=IST)
            return dt.isoformat()
        if hasattr(entry, "published") and entry.published:
            return entry.published
        return datetime.now(IST).isoformat()

    async def fetch_feed(self, session: aiohttp.ClientSession, feed_config: dict) -> list[dict]:
        name = feed_config["name"]
        url = feed_config["url"]
        lang = feed_config["lang"]
        articles = []

        try:
            headers = {
                "User-Agent": "GreyCell-ElectionTracker/1.0 (Research; +https://greycell.in)",
                "Accept": "application/rss+xml, application/xml, text/xml",
            }
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status != 200:
                    logger.warning(f"[{name}] HTTP {resp.status}")
                    return []
                raw = await resp.text()

            feed = feedparser.parse(raw)
            if feed.bozo and not feed.entries:
                logger.warning(f"[{name}] Feed parse error: {feed.bozo_exception}")
                return []

            for entry in feed.entries:
                title = getattr(entry, "title", "").strip()
                link = getattr(entry, "link", "").strip()
                summary = getattr(entry, "summary", "")
                # Strip HTML from summary
                summary = re.sub(r"<[^>]+>", "", summary).strip()[:200]

                if not title or not link:
                    continue

                if not self._is_election_related(title, summary, lang):
                    continue

                aid = self._article_hash(title, link)
                if aid in self.seen_hashes:
                    continue

                articles.append({
                    "id": aid,
                    "title": title,
                    "source": name,
                    "url": link,
                    "published": self._parse_date(entry),
                    "scraped_at": datetime.now(IST).isoformat(),
                    "summary": summary,
                    "lang": lang,
                    "sentiment": None,  # filled by sentiment engine
                })
                self.seen_hashes.add(aid)

            logger.info(f"[{name}] Fetched {len(articles)} new election articles")

        except asyncio.TimeoutError:
            logger.warning(f"[{name}] Timeout")
        except Exception as e:
            logger.error(f"[{name}] Error: {e}")

        return articles

    async def scrape_all(self) -> list[dict]:
        new_articles = []
        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
        conn = aiohttp.TCPConnector(ssl=ssl_ctx)
        async with aiohttp.ClientSession(connector=conn) as session:
            tasks = [self.fetch_feed(session, feed) for feed in RSS_FEEDS]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, list):
                    new_articles.extend(result)
                elif isinstance(result, Exception):
                    logger.error(f"Feed error: {result}")

        # Merge with existing, sort by published date descending
        all_articles = new_articles + self.existing_articles

        # Remove old articles beyond dedup window
        cutoff = datetime.now(IST) - timedelta(hours=DEDUP_HOURS)
        filtered = []
        for a in all_articles:
            try:
                pub = datetime.fromisoformat(a["published"])
                if pub > cutoff:
                    filtered.append(a)
            except (ValueError, KeyError):
                filtered.append(a)

        # Sort newest first, trim
        filtered.sort(key=lambda x: x.get("published", ""), reverse=True)
        filtered = filtered[:MAX_NEWS_ITEMS]

        # Save
        output = {
            "last_updated": datetime.now(IST).isoformat(),
            "total_articles": len(filtered),
            "articles": filtered,
        }
        os.makedirs(os.path.dirname(NEWS_FEED_FILE), exist_ok=True)
        with open(NEWS_FEED_FILE, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        self.existing_articles = filtered
        logger.info(f"Total articles: {len(filtered)} ({len(new_articles)} new)")
        return filtered
