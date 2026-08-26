#!/bin/sh
set -eu

npm ci
npm test
npm run ci:container
