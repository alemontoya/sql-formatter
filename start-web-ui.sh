#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -f "core/dist/index.js" ]; then
  echo "Building @sql-formatter/core..."
  npm run build -w core
fi

echo "Starting SQL Formatter web UI... (Ctrl+C to stop it)"
npm run dev -w web -- --open
