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

# Deploy ubazar-scraper (ubazar.gastronom.ae) — same repo, separate folder
if [ -d /home/fullevqf/ubazar-scraper ]; then
  cd /home/fullevqf/ubazar-scraper
  git pull

  source /home/fullevqf/nodevenv/ubazar-scraper/20/bin/activate
  npm install

  mkdir -p tmp
  touch tmp/restart.txt

  echo "[deploy] ubazar-scraper deployed OK"
else
  echo "[deploy] ubazar-scraper folder not found, skipping"
fi
