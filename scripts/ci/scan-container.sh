#!/bin/sh
set -eu
: "${IMAGE_TAG:=biovalidator:preflight}"
: "${TRIVY_IMAGE:=aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c}"
archive=$(mktemp)
scanner=
cleanup() {
  rm -f "$archive"
  if [ -n "$scanner" ]; then docker rm -f "$scanner" >/dev/null 2>&1 || true; fi
}
trap cleanup 0 HUP INT TERM
# Copy the archive rather than exposing the Docker socket to the scanner.
# This also works with a remote Docker-in-Docker daemon.
docker save --output "$archive" "$IMAGE_TAG"
scanner=$(docker create "$TRIVY_IMAGE" image --input /image.tar --scanners vuln,secret --severity HIGH,CRITICAL --exit-code 1 --no-progress)
docker cp "$archive" "$scanner:/image.tar"
docker start --attach "$scanner"
result=$(docker inspect --format '{{.State.ExitCode}}' "$scanner")
[ "$result" = 0 ]
