#!/usr/bin/env bash
# Resolve immutable digests for the base images used by broker + signer.
#
# Prints the resolved digest and the exact Dockerfile replacement line.
# Fails if a placeholder is still present after the owner-run substitution.
# Prints NO secrets.

set -euo pipefail

ARCH="${ARCH:-linux/amd64}"

resolve() {
  local ref="$1"
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is required" >&2; exit 2
  fi
  docker pull --platform "$ARCH" "$ref" >/dev/null
  local digest
  digest=$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2>/dev/null \
    || docker inspect --format '{{index .RepoDigests 0}}' "$ref" | awk -F@ '{print $2}')
  if [[ -z "$digest" || "$digest" != sha256:* ]]; then
    echo "ERROR: could not resolve digest for $ref" >&2; exit 3
  fi
  echo "$digest"
}

PY_REF="python:3.11.9-slim"
NODE_REF="node:20.11.1-alpine"

PY_DIGEST=$(resolve "$PY_REF")
NODE_DIGEST=$(resolve "$NODE_REF")

echo "== Resolved digests (platform=${ARCH}) =="
echo "  ${PY_REF}   -> ${PY_DIGEST}"
echo "  ${NODE_REF} -> ${NODE_DIGEST}"
echo
echo "== Apply to signer/Dockerfile (both FROM lines) =="
echo "FROM ${PY_REF}@${PY_DIGEST} AS builder"
echo "FROM ${PY_REF}@${PY_DIGEST} AS runtime"
echo
echo "== Apply to broker/Dockerfile (both FROM lines) =="
echo "FROM ${NODE_REF}@${NODE_DIGEST} AS builder"
echo "FROM ${NODE_REF}@${NODE_DIGEST} AS runtime"
echo

echo "== Placeholder check =="
FAIL=0
for f in signer/Dockerfile broker/Dockerfile; do
  if grep -q 'REPLACE_WITH_VERIFIED_DIGEST' "$f"; then
    echo "  PENDING: $f still contains REPLACE_WITH_VERIFIED_DIGEST"
    FAIL=1
  else
    echo "  OK:      $f has no placeholder"
  fi
done

if [[ "$FAIL" -ne 0 ]]; then
  echo
  echo "Replace the placeholders manually (never auto-commit), then re-run this script."
  exit 4
fi

echo
echo "All Dockerfiles are digest-pinned. Verify the same digest is used in both stages of each file."
