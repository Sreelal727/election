"""FastAPI server for the live election tracker."""
import json
import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from config import (
    BASE_DIR, LIVE_DATA_DIR,
    PREDICTIONS_LIVE_FILE, PREDICTIONS_BASE, SUMMARY_BASE,
    NEWS_FEED_FILE, SENTIMENT_FILE, TRENDS_FILE, STATUS_FILE,
)
from scheduler import Scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("server")

scheduler = Scheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(LIVE_DATA_DIR, exist_ok=True)
    logger.info("Starting scheduler...")
    await scheduler.start()
    logger.info("Server ready.")
    yield
    logger.info("Shutting down scheduler...")
    await scheduler.stop()


app = FastAPI(title="Kerala 2026 Live Election Tracker", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _read_json(filepath: str, fallback: str | None = None) -> dict | list:
    target = filepath if os.path.exists(filepath) else fallback
    if target and os.path.exists(target):
        with open(target, encoding="utf-8") as f:
            return json.load(f)
    return {}


@app.get("/api/predictions")
async def get_predictions():
    data = _read_json(PREDICTIONS_LIVE_FILE)
    if not data:
        # Fallback: serve base predictions in the live format
        base = _read_json(PREDICTIONS_BASE)
        base_summary = _read_json(SUMMARY_BASE)
        if base:
            return JSONResponse({
                "last_updated": None,
                "predictions": base,
                "summary": {
                    "seat_projections": base_summary.get("seat_projections", {}),
                    "categories": base_summary.get("categories", {}),
                    "config": base_summary.get("config", {}),
                },
            })
    return JSONResponse(data)


@app.get("/api/news")
async def get_news():
    return JSONResponse(_read_json(NEWS_FEED_FILE) or {"articles": [], "total_articles": 0})


@app.get("/api/sentiment")
async def get_sentiment():
    return JSONResponse(_read_json(SENTIMENT_FILE) or {
        "current_scores": {"LDF": 0, "UDF": 0, "NDA": 0},
        "momentum": {"LDF": "stable", "UDF": "stable", "NDA": "stable"},
        "hourly": [],
    })


@app.get("/api/trends")
async def get_trends():
    return JSONResponse(_read_json(TRENDS_FILE) or {"updates": []})


@app.get("/api/status")
async def get_status():
    return JSONResponse(_read_json(STATUS_FILE) or {"errors": ["System starting..."]})


@app.get("/api/summary")
async def get_summary():
    live = _read_json(PREDICTIONS_LIVE_FILE)
    if live and "summary" in live:
        return JSONResponse(live["summary"])
    return JSONResponse(_read_json(SUMMARY_BASE) or {})


# Static file serving — terminal, live page, dataset, then existing web
TERMINAL_DIR = os.path.join(BASE_DIR, "terminal")
DATASET_DIR = os.path.join(BASE_DIR, "dataset")
LIVE_DIR = os.path.join(BASE_DIR, "live")
WEB_DIR = os.path.join(BASE_DIR, "web")

if os.path.isdir(TERMINAL_DIR):
    app.mount("/terminal", StaticFiles(directory=TERMINAL_DIR, html=True), name="terminal")

if os.path.isdir(DATASET_DIR):
    app.mount("/dataset", StaticFiles(directory=DATASET_DIR), name="dataset")

if os.path.isdir(LIVE_DATA_DIR):
    app.mount("/data", StaticFiles(directory=LIVE_DATA_DIR), name="livedata")

if os.path.isdir(LIVE_DIR):
    app.mount("/live", StaticFiles(directory=LIVE_DIR, html=True), name="live")

if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
