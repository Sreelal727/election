#!/bin/bash
# Kerala 2026 Live Election Tracker — Launch Script
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "  Kerala 2026 Live Election Tracker"
echo "  GreyCell | Independent Electoral Intelligence"
echo "=========================================="
echo "Starting at $(date)"
echo ""

# Create data directory
mkdir -p data/live

# Install dependencies (idempotent)
echo "[1/3] Checking dependencies..."
pip3 install -q feedparser beautifulsoup4 certifi 2>/dev/null

# Prevent macOS sleep
echo "[2/3] Preventing system sleep..."
caffeinate -d &
CAFF_PID=$!

# Start server
echo "[3/3] Starting FastAPI server..."
echo ""
echo "  Overview:    http://localhost:8000/"
echo "  Live Stream: http://localhost:8000/live/"
echo "  API Status:  http://localhost:8000/api/status"
echo ""
echo "  For public access, run in another terminal:"
echo "    cloudflared tunnel --url http://localhost:8000"
echo ""
echo "  Press Ctrl+C to stop"
echo "=========================================="
echo ""

# Cleanup on exit
trap "kill $CAFF_PID 2>/dev/null; echo 'Stopped.'" EXIT

cd "$SCRIPT_DIR/server"
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000 --log-level info
