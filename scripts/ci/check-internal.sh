#!/bin/sh
set -eu

npm ci
node scripts/ci/check-deployment.js --with-routing
npm run test:internal -- --runInBand
npm audit --omit=dev --audit-level=moderate
