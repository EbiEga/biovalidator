#!/bin/sh
set -eu

command -v docker >/dev/null
attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Docker daemon did not become ready" >&2
    docker info
    exit 1
  fi
  sleep 1
done
