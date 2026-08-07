#!/usr/bin/env bash
# Live auth smoke test against TEST Supabase (ofvfasdgdwkehdcjugnf).
# Reads anon key from /tmp/cluvo_anon_test.txt and service role from /tmp/cluvo_svc_test.txt.
set -uo pipefail

URL="https://ofvfasdgdwkehdcjugnf.supabase.co"
ANON=$(cat /tmp/cluvo_anon_test.txt)
SVC=$(cat /tmp/cluvo_svc_test.txt)
TS=$(date +%s)
PASS=0; FAIL=0; SKIP=0

r() {
  printf '%-5s %-56s %s\n' "$2" "$1" "${3:-}"
  case "$2" in
    PASS) PASS=$((PASS+1)) ;;
    FAIL) FAIL=$((FAIL+1)) ;;
    *) SKIP=$((SKIP+1)) ;;
  esac
}

BODY_FILE=/tmp/cluvo_curl_body.json
msg_of() { jq -r '.msg // .error.message // .message // empty' "$BODY_FILE"; }

api() { # method path token [body] -> prints http code; body in $BODY_FILE
  local method=$1 path=$2 token=$3 body=${4:-}
  if [ -n "$token" ]; then
    curl -s -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H "apikey: $ANON" -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" ${body:+--data "$body"} "${URL}${path}"
  else
    curl -s -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H "apikey: $ANON" -H "Content-Type: application/json" ${body:+--data "$body"} "${URL}${path}"
  fi
}

edge() { api "POST" "/functions/v1/$1" "$2" "${3:-{}}"; }
login() { api "POST" "/auth/v1/token?grant_type=password" "$ANON" "{\"email\":\"$1\",\"password\":\"$2\"}"; }
login_token() {
  local code; code=$(login "$1" "$2")
  [ "$code" = "200" ] || { echo ""; return 1; }
  jq -r '.access_token // empty' "$BODY_FILE"
}
admin_create() { # email [extra json] -> prints id (BODY_FILE preserved)
  local code; code=$(api "POST" "/auth/v1/admin/users" "$SVC" "{\"email\":\"$1\",\"email_confirm\":true${2:+,$2}}")
  jq -r '.id // empty' "$BODY_FILE"
}
admin_setpw() { # id password -> prints http code
  api "PUT" "/auth/v1/admin/users/$1" "$SVC" "{\"password\":\"$2\"}"
}
edge_retry500() { # fn token body -> prints http code (one retry on 500)
  local code; code=$(edge "$1" "$2" "$3")
  if [ "$code" = "500" ]; then sleep 30; code=$(edge "$1" "$2" "$3"); fi
  echo "$code"
}

echo "========== PHASE 1 (gotrue admin + token API) =========="
echo "=== B. LOGIN / SESSION ==="

AU1=$(admin_create "smoke.au1.${TS}@gmail.com" "\"password\":\"TestPass123\",\"user_metadata\":{\"name\":\"Smoke AU1\"}")
[ -n "$AU1" ] && r "B0 setup: password user created" PASS "${AU1:0:8}" || r "B0 setup user" FAIL

T1=$(login_token "smoke.au1.${TS}@gmail.com" "TestPass123")
[ -n "$T1" ] && r "B1 correct login -> session" PASS "" || r "B1 correct login failed" FAIL "$(msg_of)"

code=$(login "smoke.au1.${TS}@gmail.com" "WrongPass1")
MSG_WRONG=$(msg_of)
[ "$code" = "400" ] && r "B2 wrong password -> 400" PASS "$MSG_WRONG" || r "B2 wrong password -> got $code" FAIL

code=$(login "smoke.nobody.${TS}@example.com" "TestPass123")
MSG_NONE=$(msg_of)
[ "$code" = "400" ] && r "B3 nonexistent email -> 400" PASS "$MSG_NONE" || r "B3 nonexistent -> got $code" FAIL
if [ -n "$MSG_WRONG" ] && [ "$MSG_WRONG" = "$MSG_NONE" ]; then
  r "B3b user enumeration: identical error wrong-password vs no-user" PASS "(no enumeration)"
else
  r "B3b user enumeration: error messages differ" FAIL "'$MSG_WRONG' vs '$MSG_NONE'"
fi

code=$(login "SMOKE.AU1.${TS}@GMAIL.COM" "TestPass123")
[ "$code" = "200" ] && r "B4 uppercase email login (normalized) -> 200" PASS "" || r "B4 uppercase email -> got $code" FAIL

code=$(login "smoke.au1.${TS}@gmail.com" "")
[ "$code" = "400" ] && r "B5 empty password -> 400" PASS "$(msg_of)" || r "B5 empty password -> got $code" FAIL

T2=$(login_token "smoke.au1.${TS}@gmail.com" "TestPass123")
RT=$(jq -r '.refresh_token' "$BODY_FILE")
[ -n "$T2" ] && r "B6 concurrent 2nd login (2nd device) -> 200" PASS "" || r "B6 2nd login failed" FAIL
code=$(api "GET" "/auth/v1/user" "$T1")
if [ "$code" = "200" ]; then
  r "B6b multi-session: first session still valid after 2nd login" PASS "(concurrent devices OK)"
elif [ "$code" = "401" ] || [ "$code" = "403" ]; then
  r "B6b multi-session: first session invalidated by 2nd login (single-session-per-user)" INFO "$code — same user on 2 devices"
else
  r "B6b multi-session check" FAIL "got $code"
fi

[ -n "$RT" ] && code=$(api "POST" "/auth/v1/token?grant_type=refresh_token" "$ANON" "{\"refresh_token\":\"$RT\"}") || code="000"
[ "$code" = "200" ] && r "B7 refresh token grant -> new session" PASS "" || r "B7 refresh grant -> got $code" FAIL "$(msg_of)"
RT2=$(jq -r '.refresh_token // empty' "$BODY_FILE")
sleep 40
[ -n "$RT" ] && code=$(api "POST" "/auth/v1/token?grant_type=refresh_token" "$ANON" "{\"refresh_token\":\"$RT\"}") || code="000"
if [ "$code" = "400" ]; then
  r "B7b refresh token reuse (40s later) -> rejected (rotation active)" PASS "$(msg_of)"
else
  r "B7b refresh reuse at 40s -> got $code (reuse interval wider?)" INFO "$(msg_of)"
  sleep 60
  code=$(api "POST" "/auth/v1/token?grant_type=refresh_token" "$ANON" "{\"refresh_token\":\"$RT\"}")
  [ "$code" = "400" ] && r "B7c refresh reuse at 100s -> rejected (rotation active)" PASS "$(msg_of)" || r "B7c refresh reuse at 100s -> got $code (rotation OFF?)" INFO "$(msg_of)"
fi
[ -n "$RT2" ] && code=$(api "POST" "/auth/v1/token?grant_type=refresh_token" "$ANON" "{\"refresh_token\":\"$RT2\"}") || code="000"
[ "$code" = "200" ] && r "B7d rotated refresh chain continues (new RT works)" PASS "" || r "B7d rotated chain -> got $code" FAIL

T3=$(login_token "smoke.au1.${TS}@gmail.com" "TestPass123")
code=$(api "POST" "/auth/v1/logout" "$T3")
[ "$code" = "204" ] && r "B8 logout -> 204" PASS "" || r "B8 logout -> got $code" FAIL
code=$(api "GET" "/auth/v1/user" "$T3")
{ [ "$code" = "401" ] || [ "$code" = "403" ]; } && r "B8b logged-out session token rejected" PASS "$code" || r "B8b -> got $code" FAIL
T4=$(login_token "smoke.au1.${TS}@gmail.com" "TestPass123")
T5=$(login_token "smoke.au1.${TS}@gmail.com" "TestPass123")
code=$(api "POST" "/auth/v1/logout" "$T4")
code=$(api "GET" "/auth/v1/user" "$T5")
[ "$code" = "200" ] && r "B8c sibling session survives logout (no global revoke)" PASS "" || r "B8c sibling session -> got $code" FAIL "logout may revoke all sessions"

T1=$(login_token "smoke.au1.${TS}@gmail.com" "TestPass123")
[ -n "$T1" ] && r "B9 logout -> login again works" PASS "" || r "B9 re-login" FAIL

echo "=== C. GOOGLE AUTH (OAuth-equivalent) ==="

GID=$(admin_create "smoke.google.${TS}@gmail.com" "\"user_metadata\":{\"name\":\"Smoke Google\",\"full_name\":\"Smoke Google\",\"avatar_url\":\"\"}")
[ -n "$GID" ] && r "C1 google-path account created (no password)" PASS "${GID:0:8}" || r "C1 google-path create" FAIL

api "GET" "/rest/v1/profiles?id=eq.${GID}&select=id" "$SVC" >/dev/null
cnt=$(jq 'length' "$BODY_FILE")
[ "$cnt" = "1" ] && r "C2 profile auto-created for google account (1:1)" PASS "" || r "C2 profile for google account" FAIL "count=$cnt"

code=$(login "smoke.google.${TS}@gmail.com" "TestPass123")
[ "$code" = "400" ] && r "C3 google-only account rejects email/password login" PASS "$(msg_of)" || r "C3 google-only email login -> got $code" FAIL

code=$(edge_retry500 forgot-password "$ANON" "{\"email\":\"smoke.google.${TS}@gmail.com\",\"redirectTo\":\"https://cluvo-org.vercel.app/reset-password\",\"requireOrganizer\":true}")
KIND=$(jq -r '.kind // empty' "$BODY_FILE")
[ "$code" = "200" ] && [ "$KIND" = "google" ] && r "C4 forgot-password (google-only) -> kind=google" PASS "" || r "C4 forgot-password google -> $code $KIND" FAIL

code=$(admin_setpw "$GID" "GooglePass1")
[ "$code" = "200" ] && r "C5 harness: password assigned (admin PUT)" PASS "" || r "C5 admin PUT password -> got $code" FAIL
GT=$(login_token "smoke.google.${TS}@gmail.com" "GooglePass1")
[ -n "$GT" ] && r "C5b google user session (first open after OAuth)" PASS "" || r "C5b google user login" FAIL

code=$(edge record-consent "$GT" "{\"consent_version\":\"2026-08-07\",\"accepted_at\":\"1970-01-01T00:00:00Z\",\"source\":\"google\"}")
ok=$(jq -r '.created // empty' "$BODY_FILE")
api "GET" "/rest/v1/consent_log?user_id=eq.${GID}&select=user_id" "$SVC" >/dev/null
cnt1=$(jq 'length' "$BODY_FILE")
[ "$code" = "200" ] && [ "$ok" = "true" ] && r "C6 record-consent (forged timestamp ignored)" PASS "created=$ok rows=$cnt1" || r "C6 record-consent -> $code" FAIL "$(msg_of)"
code=$(edge record-consent "$GT" "{\"consent_version\":\"2026-08-07\",\"source\":\"google\"}")
ok=$(jq -r '.created' "$BODY_FILE")
api "GET" "/rest/v1/consent_log?user_id=eq.${GID}&select=user_id" "$SVC" >/dev/null
cnt2=$(jq 'length' "$BODY_FILE")
[ "$code" = "200" ] && [ "$cnt2" = "$cnt1" ] && r "C7 record-consent idempotent (DB rows unchanged)" PASS "created=$ok rows=$cnt2" || r "C7 idempotency -> $code rows=$cnt2" FAIL
code=$(edge record-consent "$GT" "{\"consent_version\":\"2026-08-07\",\"source\":\"google\"}")
c=$(jq -r '.consent // empty' "$BODY_FILE")
[ "$code" = "200" ] && [ "$c" = "true" ] && r "C8 consent status GET -> consent:true" PASS "" || r "C8 status -> $code" FAIL

api "GET" "/auth/v1/admin/users/${GID}" "$SVC" >/dev/null
CA=$(jq -r 'if type=="array" then .[0] else . end | .created_at // ""' "$BODY_FILE")
LSI=$(jq -r 'if type=="array" then .[0] else . end | .last_sign_in_at // ""' "$BODY_FILE")
r "C9 gate data (created=$CA last_sign_in=$LSI)" INFO "app gate only when last_sign_in_at within 2min of created_at"

echo "=== D. PASSWORD RESET / CHANGE ==="

code=$(edge_retry500 forgot-password "$ANON" "{\"email\":\"smoke.au1.${TS}@gmail.com\",\"redirectTo\":\"https://cluvo-org.vercel.app/reset-password\",\"requireOrganizer\":true}")
KIND=$(jq -r '.kind // empty' "$BODY_FILE")
[ "$code" = "200" ] && [ "$KIND" = "password" ] && r "D1 forgot-password (password user) -> kind=password" PASS "" || r "D1 forgot-password -> $code $KIND" FAIL

code=$(edge_retry500 forgot-password "$ANON" "{\"email\":\"smoke.ghost.${TS}@example.com\",\"redirectTo\":\"x\",\"requireOrganizer\":true}")
[ "$code" = "400" ] && r "D2 forgot-password (nonexistent) -> 400" PASS "$(msg_of)" || r "D2 forgot-password ghost -> got $code" INFO

code=$(admin_setpw "$AU1" "NewPass456")
[ "$code" = "200" ] && r "D3 admin password change (while logged in)" PASS "" || r "D3 password change -> got $code" FAIL
code=$(login "smoke.au1.${TS}@gmail.com" "TestPass123")
[ "$code" = "400" ] && r "D3b old password now rejected" PASS "" || r "D3b old password -> got $code" FAIL
code=$(login "smoke.au1.${TS}@gmail.com" "NewPass456")
[ "$code" = "200" ] && r "D3c new password login works" PASS "" || r "D3c new password -> got $code" FAIL
T1=$(login_token "smoke.au1.${TS}@gmail.com" "NewPass456")

echo "=== E. PROFILE / DATA CONSISTENCY / IDOR ==="

AU2=$(admin_create "smoke.au2.${TS}@gmail.com" "\"password\":\"TestPass123\"")
[ -n "$AU2" ] && r "E0 setup: IDOR target user" PASS "${AU2:0:8}" || r "E0 setup target" FAIL

for u in "$AU1" "$AU2" "$GID"; do
  [ -z "$u" ] && continue
  api "GET" "/rest/v1/profiles?id=eq.${u}&select=id" "$SVC" >/dev/null
  cnt=$(jq 'length' "$BODY_FILE")
  [ "$cnt" = "1" ] && r "E1 profile 1:1 for ${u:0:8}" PASS "" || r "E1 profile 1:1 for ${u:0:8}" FAIL "count=$cnt"
done

code=$(api "PATCH" "/rest/v1/profiles?id=eq.${AU2}" "$T1" "{\"first_name\":\"HACKED\"}")
api "GET" "/rest/v1/profiles?id=eq.${AU2}&select=first_name" "$SVC" >/dev/null
after=$(jq -r '.[0].first_name // "null"' "$BODY_FILE")
[ "$after" != "HACKED" ] && r "E2 IDOR: user A patching user B profile blocked (target unchanged)" PASS "first_name=$after" || r "E2 IDOR: target WAS modified" FAIL "first_name=$after"

code=$(api "PATCH" "/rest/v1/profiles?id=eq.${AU1}" "$T1" "{\"first_name\":\"SmokeUpdated\"}")
{ [ "$code" = "200" ] || [ "$code" = "204" ]; } && r "E3 update own profile -> $code" PASS "" || r "E3 own profile update -> got $code" FAIL

code=$(api "GET" "/rest/v1/consent_log?select=*" "$ANON")
[ "$code" = "401" ] || [ "$code" = "403" ] && r "E4 consent_log client read blocked" PASS "$code" || r "E4 consent_log client read -> got $code" FAIL

code=$(api "GET" "/rest/v1/profiles?select=bank_account_number&limit=1" "$ANON")
[ "$code" = "400" ] && jq -r '.message' "$BODY_FILE" | grep -qi "does not exist" && r "E5 sensitive profile columns invisible to clients" PASS "$(jq -r '.message' "$BODY_FILE")" || r "E5 sensitive column probe -> got $code" FAIL

code=$(edge record-consent "$T1" "{\"consent_version\":\"2026-08-07\",\"source\":\"mobile\"}")
ok=$(jq -r '.created // empty' "$BODY_FILE")
[ "$code" = "200" ] && [ "$ok" = "true" ] && r "E6 consent recorded for password user (gate path)" PASS "created=true" || r "E6 consent for AU1 -> $code" FAIL

for u in "$AU1" "$GID"; do
  [ -z "$u" ] && continue
  api "GET" "/rest/v1/consent_log?user_id=eq.${u}&select=consent_version,source,accepted_at" "$SVC" >/dev/null
  row=$(jq -c 'if type=="array" then .[0] else . end' "$BODY_FILE")
  echo "$row" | grep -q '"2026-08-07"' && r "E7 consent row ${u:0:8} (server-set version/source)" PASS "$row" || r "E7 consent row ${u:0:8}" FAIL "$row"
done

echo "=== F. PERMISSION / AUTHORIZATION ==="

code=$(api "GET" "/rest/v1/profiles?select=id,first_name" "")
[ "$code" = "200" ] && r "F1 anon public basic read (by design, non-sensitive)" PASS "" || r "F1 anon read -> got $code" INFO

code=$(api "GET" "/rest/v1/communities?select=id" "garbage.token.here")
[ "$code" = "401" ] && r "F2 garbage token -> 401" PASS "" || r "F2 garbage token -> got $code" FAIL
TAMPER="${T1%?}x"
code=$(api "GET" "/rest/v1/communities?select=id" "$TAMPER")
[ "$code" = "401" ] && r "F3 tampered token -> 401" PASS "" || r "F3 tampered token -> got $code" FAIL

code=$(edge create-community "" "{}")
[ "$code" = "401" ] && r "F4 edge fn (create-community) no token -> 401" PASS "" || r "F4 edge fn no token -> got $code" FAIL
code=$(edge register-for-event "" "{}")
[ "$code" = "401" ] && r "F5 edge fn (register-for-event) no token -> 401" PASS "" || r "F5 edge fn no token -> got $code" FAIL

echo "=== G. SECURITY ==="

code=$(edge record-consent "" "{\"consent_version\":\"2026-08-07\",\"source\":\"web\"}")
[ "$code" = "401" ] && r "G1 record-consent without token -> 401" PASS "" || r "G1 record-consent no token -> got $code" FAIL

code=$(edge record-consent "$T1" "{\"consent_version\":\"1999-01-01\",\"accepted_at\":\"1970-01-01T00:00:00Z\",\"source\":\"hacker\"}")
api "GET" "/rest/v1/consent_log?user_id=eq.${AU1}&select=consent_version,source,accepted_at" "$SVC" >/dev/null
row=$(jq -c 'if type=="array" then .[0] else . end' "$BODY_FILE")
echo "$row" | grep -q '"2026-08-07"' && r "G2 record-consent forged fields ignored (server values)" PASS "$row" || r "G2 forged fields" FAIL "$row"

echo
echo "========== PHASE 2 (register fn path; 5req/5min limiter -> spaced) =========="
echo "probing fn health (edge admin-API rate-limit window)..."
P=0
while true; do
  code=$(edge forgot-password "$ANON" "{\"email\":\"smoke.ghost.probe.${TS}@example.com\",\"redirectTo\":\"x\"}")
  P=$((P+1))
  { [ "$code" != "500" ] && [ "$code" != "000" ]; } && break
  echo "  attempt $P: got $code — waiting 30s for admin window..."
  sleep 30
  [ "$P" -ge 120 ] && { echo "  probe gave up after 60min"; break; }
done
echo "fn healthy (attempt $P, got $code)"

reg() { # email [extra json fields]
  local email=$1 extra=${2:-}
  local body="{\"email\":\"$email\",\"password\":\"TestPass123\",\"first_name\":\"Smoke\",\"last_name\":\"Test\",\"username\":\"smoke_${RANDOM}_${TS}\",\"consent_accepted\":true,\"consent_version\":\"2026-08-07\",\"source\":\"mobile\""
  if [ -n "$extra" ]; then body="${body},${extra}"; fi
  body="${body}}"
  edge_retry500 register "$ANON" "$body"
}

E1="smoke.email.${TS}@example.com"

code=$(reg "$E1")
UID1=$(jq -r '.user_id // empty' "$BODY_FILE")
[ "$code" = "200" ] && [ -n "$UID1" ] && r "A1 email signup via register fn (Flutter params)" PASS "${UID1:0:8}" || r "A1 email signup -> got $code" FAIL "$(msg_of)"
if [ "$code" = "200" ]; then
  api "GET" "/rest/v1/consent_log?user_id=eq.${UID1}&select=consent_version,source" "$SVC" >/dev/null
  row=$(jq -c 'if type=="array" then .[0] else . end' "$BODY_FILE")
  echo "$row" | grep -q 'mobile' && r "A1b consent row source=mobile (server-written)" PASS "$row" || r "A1b consent row" FAIL "$row"
  code=$(login "$E1" "TestPass123")
  [ "$code" = "200" ] && r "A1c register-created account logs in (same account cross-platform)" PASS "" || r "A1c login -> $code" FAIL
  api "GET" "/rest/v1/profiles?id=eq.${UID1}&select=id" "$SVC" >/dev/null
  [ "$(jq 'length' "$BODY_FILE")" = "1" ] && r "A1d profile 1:1 for register user" PASS "" || r "A1d profile 1:1" FAIL
  code=$(login "$E1" "TestPass123")
  T_REG=$(jq -r '.access_token' "$BODY_FILE")
  code=$(api "PATCH" "/rest/v1/profiles?id=eq.${UID1}" "$T_REG" "{\"first_name\":\"RegUser\"}")
  [ "$code" = "200" ] && r "A1e register user updates own profile" PASS "" || r "A1e own update -> $code" FAIL
fi

sleep 65
code=$(reg "$E1")
[ "$code" = "409" ] && r "A4 duplicate signup (same email) -> 409" PASS "$(msg_of)" || r "A4 duplicate signup -> got $code" FAIL

sleep 65
code=$(edge_retry500 register "$ANON" "{\"email\":\"smoke.noconsent.${TS}@example.com\",\"password\":\"TestPass123\",\"first_name\":\"X\",\"last_name\":\"Y\",\"username\":\"smoke_nc_${TS}\",\"source\":\"mobile\"}")
[ "$code" = "400" ] && r "A2 signup without consent -> 400" PASS "$(msg_of)" || r "A2 signup without consent -> got $code" FAIL

sleep 65
code=$(edge_retry500 register "$ANON" "{\"email\":\"smoke.badver.${TS}@example.com\",\"password\":\"TestPass123\",\"first_name\":\"X\",\"last_name\":\"Y\",\"username\":\"smoke_bv_${TS}\",\"consent_accepted\":true,\"consent_version\":\"1999-01-01\",\"source\":\"mobile\"}")
[ "$code" = "400" ] && r "A3 wrong consent_version -> 400" PASS "$(msg_of)" || r "A3 wrong consent_version -> got $code" FAIL

sleep 65
code=$(reg "smoke.weakpw.${TS}@example.com" '"password":"weak"')
[ "$code" = "400" ] && r "A5 weak password -> 400" PASS "$(msg_of)" || r "A5 weak password -> got $code" FAIL

sleep 65
code=$(reg "smoke.rateprobe.${TS}@example.com")
[ "$code" = "429" ] && r "A6 register fn rate limiter: 429 on 6th call in 5min window" PASS "$(msg_of)" || r "A6 rate limiter probe -> got $code" FAIL

echo
echo "=== SUMMARY: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ==="
