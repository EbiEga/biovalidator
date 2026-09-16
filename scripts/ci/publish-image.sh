#!/bin/sh
set -eu
. scripts/ci/image-env.sh

echo "$CI_REGISTRY_PASSWORD" | docker login dockerhub.ebi.ac.uk -u "$CI_REGISTRY_USER" --password-stdin
docker push "$IMAGE_TAG"
docker push "$ADDITIONAL_IMAGE_TAG"
if [ "$CI_COMMIT_BRANCH" = "$CI_DEFAULT_BRANCH" ]; then
  docker tag "$IMAGE_TAG" "$CI_REGISTRY_IMAGE:latest"
  docker push "$CI_REGISTRY_IMAGE:latest"
fi
