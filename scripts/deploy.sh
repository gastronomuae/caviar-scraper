#!/bin/bash

set -euo pipefail

cd /home/fullevqf/caviar-scraper
git pull

source /home/fullevqf/nodevenv/caviar-scraper/20/bin/activate
npm install

mkdir -p tmp
touch tmp/restart.txt

