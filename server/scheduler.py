"""Async scheduler — runs scrape + sentiment every 30 min, predictions every 60 min."""
import asyncio
import json
import os
import logging
from datetime import datetime, timedelta, timezone

from config import (
    SCRAPE_INTERVAL_MINUTES, PREDICTION_INTERVAL_MINUTES,
    STATUS_FILE, NEWS_FEED_FILE, LIVE_DATA_DIR,
)
from scraper import NewsScraper
from sentiment import SentimentEngine
from lite_monte_carlo import LiteMonteCarlo

logger = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))


class Scheduler:
    def __init__(self):
        self.scraper = NewsScraper()
        self.sentiment = SentimentEngine()
        self.monte_carlo = LiteMonteCarlo()
        self._scrape_task: asyncio.Task | None = None
        self._predict_task: asyncio.Task | None = None
        self.started_at: datetime | None = None
        self.last_scrape: datetime | None = None
        self.last_prediction: datetime | None = None
        self.errors: list[str] = []

    async def start(self):
        os.makedirs(LIVE_DATA_DIR, exist_ok=True)
        self.started_at = datetime.now(IST)

        logger.info("Loading keywords and base data...")
        self.scraper.load_keywords()
        self.sentiment.load_keywords()
        self.monte_carlo.load_base_data()

        # Run initial cycles
        logger.info("Running initial scrape cycle...")
        await self.run_scrape_cycle()
        logger.info("Running initial prediction cycle...")
        await self.run_prediction_cycle()

        # Start periodic loops with done-callbacks to catch silent deaths
        def _task_done(name):
            def cb(task):
                if task.cancelled():
                    logger.info(f"{name} task cancelled.")
                elif task.exception():
                    logger.error(f"{name} task died with exception: {task.exception()}")
                else:
                    logger.warning(f"{name} task exited unexpectedly (no error).")
            return cb

        self._scrape_task = asyncio.create_task(self._scrape_loop())
        self._scrape_task.add_done_callback(_task_done("Scrape"))
        self._predict_task = asyncio.create_task(self._predict_loop())
        self._predict_task.add_done_callback(_task_done("Predict"))
        logger.info(f"Scheduler started. Scrape every {SCRAPE_INTERVAL_MINUTES}min, predict every {PREDICTION_INTERVAL_MINUTES}min.")

    async def stop(self):
        if self._scrape_task:
            self._scrape_task.cancel()
        if self._predict_task:
            self._predict_task.cancel()
        logger.info("Scheduler stopped.")

    async def _scrape_loop(self):
        while True:
            try:
                await asyncio.sleep(SCRAPE_INTERVAL_MINUTES * 60)
                logger.info("Scheduled scrape cycle starting...")
                await self.run_scrape_cycle()
            except asyncio.CancelledError:
                logger.info("Scrape loop cancelled.")
                return
            except Exception as e:
                logger.error(f"Scrape loop error (will retry next cycle): {e}")
                self.errors.append(f"{datetime.now(IST).isoformat()}: scrape loop: {e}")
                self.errors = self.errors[-20:]

    async def _predict_loop(self):
        while True:
            try:
                await asyncio.sleep(PREDICTION_INTERVAL_MINUTES * 60)
                logger.info("Scheduled prediction cycle starting...")
                await self.run_prediction_cycle()
            except asyncio.CancelledError:
                logger.info("Predict loop cancelled.")
                return
            except Exception as e:
                logger.error(f"Predict loop error (will retry next cycle): {e}")
                self.errors.append(f"{datetime.now(IST).isoformat()}: predict loop: {e}")
                self.errors = self.errors[-20:]

    async def run_scrape_cycle(self):
        try:
            articles = await self.scraper.scrape_all()
            articles = self.sentiment.classify_all(articles)

            # Re-save with sentiment data
            output = {
                "last_updated": datetime.now(IST).isoformat(),
                "total_articles": len(articles),
                "articles": articles,
            }
            with open(NEWS_FEED_FILE, "w", encoding="utf-8") as f:
                json.dump(output, f, ensure_ascii=False, indent=2)

            self.sentiment.compute_hourly_trend(articles)
            self.last_scrape = datetime.now(IST)
            self.update_status()

        except Exception as e:
            msg = f"Scrape cycle error: {e}"
            logger.error(msg)
            self.errors.append(f"{datetime.now(IST).isoformat()}: {msg}")
            self.errors = self.errors[-20:]

    async def run_prediction_cycle(self):
        try:
            adj = self.sentiment.get_sentiment_adjustment()
            logger.info(f"Sentiment adjustments: {adj}")

            # Run in thread pool to not block event loop
            loop = asyncio.get_event_loop()
            predictions, summary = await loop.run_in_executor(
                None, self.monte_carlo.run_simulation, adj
            )

            hot = self.monte_carlo.identify_hot_constituencies(predictions)
            self.monte_carlo.save_and_trend(predictions, summary, hot)
            self.last_prediction = datetime.now(IST)
            self.update_status()

        except Exception as e:
            msg = f"Prediction cycle error: {e}"
            logger.error(msg)
            self.errors.append(f"{datetime.now(IST).isoformat()}: {msg}")
            self.errors = self.errors[-20:]

    def update_status(self):
        now = datetime.now(IST)
        status = {
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "last_scrape": self.last_scrape.isoformat() if self.last_scrape else None,
            "last_prediction": self.last_prediction.isoformat() if self.last_prediction else None,
            "next_scrape": (self.last_scrape + timedelta(minutes=SCRAPE_INTERVAL_MINUTES)).isoformat() if self.last_scrape else None,
            "next_prediction": (self.last_prediction + timedelta(minutes=PREDICTION_INTERVAL_MINUTES)).isoformat() if self.last_prediction else None,
            "uptime_hours": round((now - self.started_at).total_seconds() / 3600, 1) if self.started_at else 0,
            "errors": self.errors[-5:],
        }
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            json.dump(status, f, ensure_ascii=False, indent=2)
