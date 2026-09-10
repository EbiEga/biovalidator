#!/bin/sh
set -eu
: "${DEPLOY_IMAGE:?Set DEPLOY_IMAGE to the commit-specific image tag or digest}"
awk -v image="$DEPLOY_IMAGE" '
  /^[[:space:]]+image:/ { sub(/image:.*/, "image: \"" image "\"") }
  { print }
' k8s/deployment.yaml
