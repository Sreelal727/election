#!/bin/bash
# Deploy live page + data to Vercel
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Deploying to Vercel ==="

# 1. Copy live page into web/live/
echo "[1/3] Syncing live page files..."
mkdir -p web/live/data
cp live/index.html web/live/
cp live/live.css web/live/
cp live/live.js web/live/

# 2. Copy latest data
echo "[2/3] Syncing live data..."
cp data/live/news_feed.json web/live/data/ 2>/dev/null || echo "  (no news_feed.json yet)"
cp data/live/predictions_live.json web/live/data/ 2>/dev/null || echo "  (no predictions_live.json yet)"
cp data/live/sentiment_hourly.json web/live/data/ 2>/dev/null || echo "  (no sentiment_hourly.json yet)"
cp data/live/trends.json web/live/data/ 2>/dev/null || echo "  (no trends.json yet)"
cp data/live/system_status.json web/live/data/ 2>/dev/null || echo "  (no system_status.json yet)"

# 3. Deploy
echo "[3/3] Pushing to Vercel..."
cd web
vercel --prod --yes

echo ""
echo "=== Done! ==="
echo "Live page: <your-vercel-url>/live/"
