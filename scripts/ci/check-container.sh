#!/bin/sh
set -eu

REVISION=${REVISION:-}
if [ -z "$REVISION" ]; then
  REVISION=$(git rev-parse HEAD 2>/dev/null || printf '%s' unknown)
fi
[ -n "$REVISION" ] || REVISION=unknown

IMAGE_TAG=${IMAGE_TAG:-biovalidator:preflight}
[ -n "$IMAGE_TAG" ] || IMAGE_TAG=biovalidator:preflight
ADDITIONAL_IMAGE_TAG=${ADDITIONAL_IMAGE_TAG:-}

set -- docker build --build-arg "REVISION=$REVISION" --tag "$IMAGE_TAG"
if [ -n "$ADDITIONAL_IMAGE_TAG" ]; then
  set -- "$@" --tag "$ADDITIONAL_IMAGE_TAG"
fi
set -- "$@" .

echo "Building container image: $IMAGE_TAG"
"$@"

echo "Running container smoke check: $IMAGE_TAG --help"
docker run --rm "$IMAGE_TAG" --help

CONTAINER_ID=$(docker run -d --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=128m --memory=2g --cpus=1 -e BIOVALIDATOR_BASE_URL=/biovalidator "$IMAGE_TAG")
cleanup() { docker stop -t 80 "$CONTAINER_ID" >/dev/null 2>&1 || true; }
trap cleanup 0 HUP INT TERM
if ! docker exec -i "$CONTAINER_ID" node < scripts/ci/smoke-server.js; then
  docker logs "$CONTAINER_ID"
  exit 1
fi
