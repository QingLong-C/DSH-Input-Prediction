#!/usr/bin/env bash
set -euo pipefail
npm install --global pnpm@10.33.2
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test:cn
pnpm test:smoke
node --experimental-strip-types scripts/context-summary-smoke.mjs
pnpm test:sync
