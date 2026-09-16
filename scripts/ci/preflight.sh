#!/bin/sh
set -eu

npm ci
node scripts/ci/rehearse-gitlab.js
