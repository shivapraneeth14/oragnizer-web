#!/usr/bin/env bash
# Environment-hygiene regression check for the Vite apps + edge functions.
#
# PERMANENT RULE (docs/ENV.md): no environment defaults or hardcoded
# environment values in source code. This script fails CI when any of the
# following appear anywhere it scans:
#   - `||` fallbacks / default assignment to env-reads (VITE_*, import.meta.env)
#   - hardcoded Supabase project URLs, publishable keys, JWTs
#   - hardcoded payment keys (Razorpay, Cashfree) in source
#   - common third-party API key patterns (Google/Firebase, Stripe, AWS, SendGrid)
#
# It must NEVER be "fixed" by adding a file to the skip list. If a value is
# genuinely required in a source file, it is not an environment value and does
# not belong to this repository's environment contract.
#
# Usage: scripts/check-env-hygiene.sh

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILURES=0

check() {
  local label="$1"
  local pattern="$2"
  shift 2
  local matches
  matches="$(rg -n --no-heading "$pattern" "$@" 2>/dev/null || true)"
  if [[ -n "$matches" ]]; then
    echo "[FAIL] $label"
    echo "$matches"
    FAILURES=$((FAILURES + 1))
  else
    echo "[OK]   $label"
  fi
}

check "hardcoded supabase URL"        "[a-z0-9]{20}\\.supabase\\.co"            apps/*/src supabase/functions
check "publishable supabase key"      "sb_publishable_"                         apps/*/src
check "supabase anon JWT"             "eyJ[A-Za-z0-9_-]{10,}\\.eyJ"             apps/*/src
check "hardcoded razorpay key"        "rzp_(test|live)_[A-Za-z0-9]+"            apps/*/src
check "hardcoded cashfree key"        "CF[A-Z0-9]{8,}_[A-Za-z0-9]+|cashfree.*(client_(id|secret)|public)" apps/*/src
check "google/firebase api key"       "AIza[0-9A-Za-z_-]{20,}"                  apps/*/src supabase/functions
check "stripe api key"                "(pk|sk)_(test|live)_[A-Za-z0-9]{10,}"     apps/*/src supabase/functions
check "aws access key"                "AKIA[0-9A-Z]{16}"                        apps/*/src supabase/functions
check "sendgrid api key"              "SG\\.[A-Za-z0-9_-]{10,}"                  apps/*/src supabase/functions

check "env fallback (|| default)"     "import\\.meta\\.env\\.[A-Z0-9_]+\\s*\\|\\|\\s*[\"']"  apps/*/src
check "env fallback (?? default)"     "import\\.meta\\.env\\.[A-Z0-9_]+\\s*\\?\\?\\s*[\"']"  apps/*/src
check "env mutation (||= / ??=)"      "import\\.meta\\.env\\.[A-Z0-9_]+\\s*(\\|\\||\\?\\?)=\\s*[\"']"  apps/*/src

if [[ "$FAILURES" -gt 0 ]]; then
  echo
  echo "Environment hygiene check FAILED with $FAILURES violation(s)."
  echo "Environment values must come ONLY from build-time env vars / secrets. See docs/ENV.md."
  exit 1
fi

echo
echo "Environment hygiene check passed."
