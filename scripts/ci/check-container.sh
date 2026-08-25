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
