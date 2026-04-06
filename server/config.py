"""Shared configuration for the live election tracker."""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
LIVE_DATA_DIR = os.path.join(DATA_DIR, "live")
KEYWORDS_DIR = os.path.join(BASE_DIR, "chrome-extension", "keywords")
SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")

# Existing data files
PREDICTIONS_BASE = os.path.join(DATA_DIR, "predictions_2026.json")
SUMMARY_BASE = os.path.join(DATA_DIR, "summary_2026.json")
RESULTS_2021_CSV = os.path.join(DATA_DIR, "election_2021_results.csv")
RESULTS_2016_CSV = os.path.join(DATA_DIR, "election_2016_results.csv")
LSG_SWING_CSV = os.path.join(DATA_DIR, "lsg_district_swing.csv")
CANDIDATES_CSV = os.path.join(DATA_DIR, "candidates_2026.csv")

# Live output files
NEWS_FEED_FILE = os.path.join(LIVE_DATA_DIR, "news_feed.json")
SENTIMENT_FILE = os.path.join(LIVE_DATA_DIR, "sentiment_hourly.json")
PREDICTIONS_LIVE_FILE = os.path.join(LIVE_DATA_DIR, "predictions_live.json")
TRENDS_FILE = os.path.join(LIVE_DATA_DIR, "trends.json")
STATUS_FILE = os.path.join(LIVE_DATA_DIR, "system_status.json")

# Keyword files
ELECTION_FILTER_FILE = os.path.join(BASE_DIR, "server", "keywords", "election_filter.json")
ENGLISH_KEYWORDS_FILE = os.path.join(KEYWORDS_DIR, "english.json")
MALAYALAM_KEYWORDS_FILE = os.path.join(KEYWORDS_DIR, "malayalam.json")

# Timing
SCRAPE_INTERVAL_MINUTES = 30
PREDICTION_INTERVAL_MINUTES = 60

# Monte Carlo
LITE_SIMULATIONS = 100_000
AGGREGATE_SIMULATIONS = 10_000
SWING_DAMPENING = 0.45
VOLATILITY_BASE = 4.0
VOLATILITY_MARGIN_FACTOR = 0.03
MAX_SENTIMENT_ADJUSTMENT = 1.5  # Max +/- pct points

# Scraper
MAX_NEWS_ITEMS = 200
DEDUP_HOURS = 72

RSS_FEEDS = [
    {"name": "Mathrubhumi", "url": "http://feeds.feedburner.com/mathrubhumi", "lang": "ml"},
    {"name": "Asianet News", "url": "https://www.asianetnews.com/tag/rss", "lang": "ml"},
    {"name": "Onmanorama", "url": "https://www.onmanorama.com/news.feed", "lang": "en"},
    {
        "name": "Google News EN",
        "url": "https://news.google.com/rss/search?q=kerala+election+2026&hl=en-IN&gl=IN&ceid=IN:en",
        "lang": "en",
    },
    {
        "name": "Google News ML",
        "url": "https://news.google.com/rss/search?q=%E0%B4%95%E0%B5%87%E0%B4%B0%E0%B4%B3+%E0%B4%A4%E0%B4%BF%E0%B4%B0%E0%B4%9E%E0%B5%8D%E0%B4%9E%E0%B5%86%E0%B4%9F%E0%B5%81%E0%B4%AA%E0%B5%8D%E0%B4%AA%E0%B5%8D+2026&hl=ml&gl=IN&ceid=IN:ml",
        "lang": "ml",
    },
]
