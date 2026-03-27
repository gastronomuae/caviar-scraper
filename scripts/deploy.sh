#!/bin/bash

set -euo pipefail

# Deploy caviar-scraper (caviar.gastronom.ae)
cd /home/fullevqf/caviar-scraper
git pull

source /home/fullevqf/nodevenv/caviar-scraper/20/bin/activate
npm install

mkdir -p tmp
touch tmp/restart.txt

echo "[deploy] caviar-scraper deployed OK"

# Deploy ubazar-scraper (ubazar.gastronom.ae) — same repo, separate folder.
# Run in a subshell so any failure here does NOT fail the caviar deploy.
if [ -d /home/fullevqf/ubazar-scraper ]; then
  (
    set +e
    cd /home/fullevqf/ubazar-scraper
    git pull

    # Use caviar virtualenv (same Node version) — ubazar may not have its own yet.
    if [ -f /home/fullevqf/nodevenv/ubazar-scraper/20/bin/activate ]; then
      source /home/fullevqf/nodevenv/ubazar-scraper/20/bin/activate
    else
      source /home/fullevqf/nodevenv/caviar-scraper/20/bin/activate
    fi

    npm install
    mkdir -p tmp
    touch tmp/restart.txt
    echo "[deploy] ubazar-scraper deployed OK"
  ) || echo "[deploy] ubazar-scraper deploy failed (non-fatal)"
else
  echo "[deploy] ubazar-scraper folder not found, skipping"
fi
