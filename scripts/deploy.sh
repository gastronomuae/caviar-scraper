#!/bin/bash

set -eo pipefail

# Deploy caviar-scraper (caviar.gastronom.ae)
cd /home/fullevqf/caviar-scraper

# Save live mapping/state files before reset — server copy takes priority over git seed
cp data/product_mapping.json /tmp/caviar-mapping.bak 2>/dev/null || true
cp data/match_review_state.json /tmp/caviar-state.bak 2>/dev/null || true

git fetch origin
git checkout -- . 2>/dev/null || true
git reset --hard origin/main

# Restore live mapping/state (overwrites git seed with server's up-to-date versions)
cp /tmp/caviar-mapping.bak data/product_mapping.json 2>/dev/null || true
cp /tmp/caviar-state.bak data/match_review_state.json 2>/dev/null || true

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

    # Save live ubazar mapping before reset
    cp data/ubazar_product_mapping.json /tmp/ubazar-mapping.bak 2>/dev/null || true

    git fetch origin
    git checkout -- . 2>/dev/null || true
    git reset --hard origin/main

    # Restore live ubazar mapping
    cp /tmp/ubazar-mapping.bak data/ubazar_product_mapping.json 2>/dev/null || true

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
