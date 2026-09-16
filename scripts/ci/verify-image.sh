#!/bin/sh
set -eu
. scripts/ci/image-env.sh
: "${CI_NODE_IMAGE:?Set CI_NODE_IMAGE to the internal-tests image}"

sh scripts/ci/check-container.sh
sh scripts/ci/scan-container.sh
DEPLOY_IMAGE="$IMAGE_TAG" sh scripts/ci/render-deployment.sh > deployment-immutable.yaml

# The Docker CLI job has no Node. Stream the manifest and locked validation
# tooling into a Node container; bind mounts would not work with a remote daemon.
archive=$(mktemp)
cleanup() { rm -f "$archive"; }
trap cleanup 0
trap 'exit 1' HUP INT TERM
tar -cf "$archive" package.json package-lock.json scripts/ci/check-deployment.js k8s deployment-immutable.yaml
docker run --rm -i --entrypoint sh --workdir /workspace \
  -e EXPECTED_IMAGE="$IMAGE_TAG" "$CI_NODE_IMAGE" -ec '
    tar -xf -
    npm ci --ignore-scripts --no-audit --no-fund > /dev/null
    node scripts/ci/check-deployment.js deployment-immutable.yaml --with-routing
  ' < "$archive"
