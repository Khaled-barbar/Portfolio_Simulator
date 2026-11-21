#!/usr/bin/env bash
# Download the latest prices and publish the site (Kinsta redeploys it automatically).
# Every weekday at 18:45 with cron:   crontab -e   then add:
#   45 18 * * 1-5  /path/to/Portfolio_Simulator/scripts/publish_prices.sh --scheduled
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
if [ "$1" = "--scheduled" ]; then
  mkdir -p logs
  echo "==== $(date '+%F %T') ====" >> logs/publish.log
  PYTHONUTF8=1 python3 scripts/build_data.py --publish >> logs/publish.log 2>&1
else
  PYTHONUTF8=1 python3 scripts/build_data.py --publish "$@"
fi
