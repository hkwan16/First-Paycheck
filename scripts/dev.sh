#!/usr/bin/env bash
# Start the local stack with honcho (Procfile.dev): api, worker and, when
# web/ exists, the Next.js dev server. Runs against the hosted Supabase
# project configured in .env.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "dev.sh: .env not found; copy .env.example to .env and fill it in" >&2
  exit 1
fi

processes=(api worker)
if [ -d web ]; then
  processes+=(web)
else
  echo "dev.sh: web/ not found, starting api and worker only"
fi

exec uv run honcho --procfile Procfile.dev --env .env start "${processes[@]}"
