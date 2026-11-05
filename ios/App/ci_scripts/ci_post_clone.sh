#!/bin/sh

set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=${CI_PRIMARY_REPOSITORY_PATH:-$(CDPATH= cd -- "$SCRIPT_DIRECTORY/../../.." && pwd)}

cd "$REPOSITORY_ROOT"

if ! command -v node >/dev/null 2>&1; then
  brew install node@22
fi

NODE_BINARY_DIRECTORY=$(dirname "$(command -v node)")
export PATH="$NODE_BINARY_DIRECTORY:$PATH"

node --version
npm --version
npm ci --no-audit --no-fund
npx cap sync ios

