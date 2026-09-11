#!/bin/sh
set -eu
: "${IMAGE_TAG:=biovalidator:preflight}"
: "${TRIVY_IMAGE:=aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969}"
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
