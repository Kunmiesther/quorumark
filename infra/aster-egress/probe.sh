#!/bin/sh
set -eu

OFFICIAL_ASTER_ORIGIN="https://fapi.asterdex.com"
BASE_URL="${ASTER_API_BASE_URL:-$OFFICIAL_ASTER_ORIGIN}"
APPROVED="${ASTER_JURISDICTION_APPROVED:-false}"
INTERVAL="${ASTER_PROBE_INTERVAL_SECONDS:-30}"
TIMEOUT="${ASTER_PROBE_TIMEOUT_SECONDS:-10}"
STATE_DIR="/opt/turtlebot/state"
HEALTH_FILE="$STATE_DIR/healthy"

fail_closed() {
  rm -f "$HEALTH_FILE"
  printf '%s\n' "aster-egress: $1" >&2
  return 1
}

validate_config() {
  [ "$APPROVED" = "true" ] || fail_closed "JURISDICTION_NOT_APPROVED"
  [ "$BASE_URL" = "$OFFICIAL_ASTER_ORIGIN" ] || fail_closed "ASTER_ORIGIN_NOT_ALLOWED"

  case "$INTERVAL" in
    ''|*[!0-9]*) fail_closed "INVALID_PROBE_INTERVAL" ;;
  esac
  case "$TIMEOUT" in
    ''|*[!0-9]*) fail_closed "INVALID_PROBE_TIMEOUT" ;;
  esac

  [ "$INTERVAL" -ge 10 ] || fail_closed "PROBE_INTERVAL_TOO_LOW"
  [ "$TIMEOUT" -ge 2 ] && [ "$TIMEOUT" -le 30 ] || fail_closed "PROBE_TIMEOUT_OUT_OF_RANGE"
}

probe_once() {
  response="$(
    curl \
      --fail \
      --silent \
      --show-error \
      --proto '=https' \
      --tlsv1.2 \
      --connect-timeout "$TIMEOUT" \
      --max-time "$TIMEOUT" \
      "$BASE_URL/fapi/v3/ping"
  )" || fail_closed "ASTER_UNREACHABLE"

  compact="$(printf '%s' "$response" | tr -d '[:space:]')"
  [ "$compact" = "{}" ] || fail_closed "UNEXPECTED_ASTER_RESPONSE"

  mkdir -p "$STATE_DIR"
  date +%s > "$HEALTH_FILE"
  printf '%s\n' "aster-egress: healthy"
}

validate_config

if [ "${1:-}" = "--loop" ]; then
  while :; do
    probe_once || true
    sleep "$INTERVAL"
  done
else
  probe_once
fi
