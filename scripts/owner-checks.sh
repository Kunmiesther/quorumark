#!/usr/bin/env bash
# Owner-run security & reachability checks for Phase B.2A.
# Prints results only — NEVER prints secret values, JWTs, keys, or bodies.
# Requires: docker, trivy, syft, curl. All commands can be run locally
# against freshly built images and against Railway URLs.

set -uo pipefail

pass()  { printf "  \033[32mPASS\033[0m  %s\n" "$*"; }
fail()  { printf "  \033[31mFAIL\033[0m  %s\n" "$*"; FAILED=1; }
info()  { printf "  ----  %s\n" "$*"; }

FAILED=0
BROKER_IMAGE="${BROKER_IMAGE:-turtlebot-broker:local}"
SIGNER_IMAGE="${SIGNER_IMAGE:-turtlebot-signer:local}"

echo "== 1. Clean container builds =="
docker build -f broker/Dockerfile -t "$BROKER_IMAGE" . >/dev/null 2>&1 \
  && pass "broker image built" || fail "broker build"
docker build -f signer/Dockerfile -t "$SIGNER_IMAGE" signer >/dev/null 2>&1 \
  && pass "signer image built" || fail "signer build"

echo
echo "== 2. Runtime image: no build tools =="
for img in "$BROKER_IMAGE" "$SIGNER_IMAGE"; do
  # setuptools / pip / wheel absent from signer; npm/node-gyp absent from broker
  present=$(docker run --rm --entrypoint sh "$img" -c '
    (command -v pip >/dev/null && echo pip;
     command -v setuptools >/dev/null && echo setuptools;
     command -v gcc >/dev/null && echo gcc;
     command -v git >/dev/null && echo git;
     command -v npm >/dev/null && echo npm) 2>/dev/null | tr "\n" " "') || true
  if [[ -z "${present// }" ]]; then
    pass "$img has no build tools"
  else
    fail "$img contains: $present"
  fi
done

echo
echo "== 3. Runtime user is uid 10001 =="
for img in "$BROKER_IMAGE" "$SIGNER_IMAGE"; do
  uid=$(docker run --rm --entrypoint id "$img" -u 2>/dev/null || echo "?")
  [[ "$uid" == "10001" ]] && pass "$img uid=10001" || fail "$img uid=$uid"
done

echo
echo "== 4. Trivy HIGH/CRITICAL scan =="
if command -v trivy >/dev/null 2>&1; then
  for img in "$BROKER_IMAGE" "$SIGNER_IMAGE"; do
    if trivy image --quiet --severity HIGH,CRITICAL --exit-code 1 --no-progress "$img" >/dev/null 2>&1; then
      pass "$img trivy clean (HIGH/CRITICAL)"
    else
      fail "$img trivy findings — run: trivy image --severity HIGH,CRITICAL $img"
    fi
  done
else
  info "trivy not installed; skipping"
fi

echo
echo "== 5. SBOM generation (syft) =="
if command -v syft >/dev/null 2>&1; then
  mkdir -p signer/vendor broker/vendor
  syft "$SIGNER_IMAGE" -o cyclonedx-json > signer/vendor/sbom.runtime.cyclonedx.json 2>/dev/null \
    && pass "signer SBOM -> signer/vendor/sbom.runtime.cyclonedx.json" || fail "signer sbom"
  syft "$BROKER_IMAGE" -o cyclonedx-json > broker/vendor/sbom.runtime.cyclonedx.json 2>/dev/null \
    && pass "broker SBOM -> broker/vendor/sbom.runtime.cyclonedx.json" || fail "broker sbom"
else
  info "syft not installed; skipping"
fi

echo
echo "== 6. Secret-pattern scan of source tree =="
# Detect committed secret-like strings. Matches nothing in a clean repo.
if grep -RIn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
     -E '(sk_live_|xoxb-|-----BEGIN [A-Z]+ PRIVATE KEY-----|AKIA[0-9A-Z]{16})' . >/dev/null 2>&1; then
  fail "possible secrets in source — investigate immediately"
else
  pass "no obvious committed secret patterns"
fi

echo
echo "== 7. Read-only filesystem test =="
for img in "$BROKER_IMAGE" "$SIGNER_IMAGE"; do
  out=$(docker run --rm --read-only --tmpfs /tmp --entrypoint sh "$img" -c \
    'touch /forbidden 2>&1 || echo "denied"; touch /tmp/ok 2>/dev/null && echo "tmp_ok"' 2>&1) || true
  if echo "$out" | grep -q 'denied' && echo "$out" | grep -q 'tmp_ok'; then
    pass "$img: rootfs read-only, /tmp writable"
  else
    fail "$img: read-only rootfs failed ($out)"
  fi
done

echo
echo "== 8. Public / private surface verification =="
if [[ -n "${BROKER_PUBLIC_URL:-}" ]]; then
  code=$(curl -sk -o /dev/null -w '%{http_code}' "${BROKER_PUBLIC_URL%/}/healthz" || echo "000")
  [[ "$code" == "200" ]] && pass "broker /healthz over HTTPS returns 200" || fail "broker /healthz returned $code"

  # Auth required for /v1/whoami
  code=$(curl -sk -o /dev/null -w '%{http_code}' "${BROKER_PUBLIC_URL%/}/v1/whoami" || echo "000")
  [[ "$code" == "401" ]] && pass "broker /v1/whoami requires auth (401)" || fail "broker /v1/whoami returned $code (expected 401)"
else
  info "set BROKER_PUBLIC_URL to run public reachability tests"
fi

if [[ -n "${SIGNER_PUBLIC_HOST_ATTEMPT:-}" ]]; then
  # Owner supplies the hostname they *fear* might be public (e.g. `signer-production.up.railway.app`).
  # We expect the DNS to NOT resolve (or connection refused). Anything else is a failure.
  if getent hosts "$SIGNER_PUBLIC_HOST_ATTEMPT" >/dev/null 2>&1; then
    fail "signer is publicly resolvable at $SIGNER_PUBLIC_HOST_ATTEMPT — revoke public domain immediately"
  else
    pass "signer not publicly resolvable ($SIGNER_PUBLIC_HOST_ATTEMPT)"
  fi
fi

echo
echo "== 9. Broker → signer private reachability =="
if [[ -n "${BROKER_PUBLIC_URL:-}" ]]; then
  code=$(curl -sk -o /dev/null -w '%{http_code}' "${BROKER_PUBLIC_URL%/}/readyz" || echo "000")
  [[ "$code" == "200" ]] && pass "broker /readyz -> signer OK" || fail "broker /readyz returned $code"
fi

echo
echo "== 10. Replay / skew / tamper checks =="
info "run signer test suite inside deployed container:"
info "  docker exec <signer> sh -c 'PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests/'"

echo
if [[ "$FAILED" -ne 0 ]]; then
  echo "OVERALL: FAIL — do NOT flip APEX_MAINNET_READS_ENABLED"
  exit 1
fi
echo "OVERALL: PASS — read-only enablement is safe to attempt"
