# Test Matrix — Fresh Rescan

**Status semantics:** PASS = executed and assertion completed; FAIL = executed invariant failed; BLOCKED = safe environment/evidence unavailable; NOT RUN = not executed. Static/source PASS is explicitly labeled and is not runtime proof.

| ID | Scenario / invariant | Fixture or command | Environment | Expected | Actual | Status |
|---|---|---|---|---|---|---|
| T-001 | Repository and source files readable | `pwd`, git status, targeted source reads | Local worktree | Root and requested files exist | Root and all six artifacts/source areas readable | PASS |
| T-002 | Booking A → refund A → booking B → refund B has independent IDs/history | Disposable DB fixture | Local Supabase/Postgres unavailable | Independent registration/payment/refund/provider IDs and archived history | Not executed | BLOCKED |
| T-003 | Razorpay refund retry does not duplicate after timeout | Existing mocked refund tests + provider-timeout fixture | Local Deno mocks | One provider refund and recoverable claim | Existing concurrency tests pass; timeout/provider fixture not run | PARTIAL |
| T-004 | Late captured payment on cancelled registration is not confirmed | Migration/source assertion | Local source test | `refund_required`, no resurrection | Guard present in `202610290003_confirm_payment_refund_status.sql:54-66` | PASS (static) |
| T-005 | Pending reconciliation waits on provider uncertainty | Existing source/mocked tests | Local Deno | No premature terminal state | Existing targeted suite passed; provider integration not run | PASS (static/mocked) |
| T-006 | Customer cancellation at exactly 24h is rejected server-side | Source boundary review | Local source | Reject at `now >= start - 24h` | `cancel-registration/index.ts:66-73` does so | PASS (static) |
| T-007 | Organizer cancellation authorization | Source review + disposable request fixture | No DB runtime | Non-owner/non-team denied | Checks owner, team roles, admin at `cancel-event/index.ts:63-88`; runtime not run | PASS (static), BLOCKED runtime |
| T-008 | Organizer cancellation paid non-attendee is full-refunded | Source review + DB/provider mocks | No DB/provider runtime | Refund claim and registration cancellation | `cancel-event/index.ts:169-225` implements path; runtime not run | PASS (static), BLOCKED runtime |
| T-009 | Organizer cancellation attended attendee is not refunded | Source review | Local source | Attended payment skipped | `cancel-event/index.ts:145-167` skips | PASS (static) |
| T-010 | Pending captured payment is rescued during event cancellation | Provider mock + DB fixture | No provider/DB runtime | Captured payment linked then refunded | Rescue path exists at `cancel-event/index.ts:107-143`; not executed | BLOCKED |
| T-011 | Processing payout >24h with real provider ID queries provider first | Source invariant | Local source | No wallet restore without authoritative failure | `reconcile-payments/index.ts:517-540` restores directly | FAIL (source defect) |
| T-012 | Cashfree SUCCESS racing wallet refund yields one safe terminal state | Concurrent DB fixture | Docker/local DB unavailable | No success + wallet restore double value | Source race remains; fixture not run | BLOCKED; source risk |
| T-013 | Legacy Cashfree SUCCESS persistence failure retries safely | Mock non-throwing Supabase update | Local Deno mock not built | No acknowledged-but-unapplied success | Update/audit errors ignored at `cashfree-webhook/index.ts:97-136`; not executed | NOT RUN |
| T-014 | Two concurrent scans produce exactly one success/mutation | Concurrent RPC fixture | Docker/local DB unavailable | First writer only | Unconditional update remains in final SQL | BLOCKED; FAIL (source invariant) |
| T-015 | Organizer A scanning Organizer B ticket returns 403/no mutation | Two-principal local DB/edge fixture | No disposable DB | 403, unchanged ticket | Edge source checks event community ownership/team; runtime not run | BLOCKED; no bypass demonstrated statically |
| T-016 | Direct check-in RPC is unavailable to authenticated client | Grants/migration assertion | Local source | Service role only | Revocation/grant present at `202610090001_check_in_security.sql:86-87` | PASS (static) |
| T-017 | Flutter displays capture/refund timestamps | UI/model test with delayed webhook | Local Flutter | Capture/refund event time distinct from creation | Model has only `createdAt/updatedAt`; screens display `created_at` | FAIL (source) |
| T-018 | Re-quote persistence error fails closed | Mock Supabase update returning error without throw | Local Deno mock not built | No payable order returned | `create-payment/index.ts:313-356` does not check existing-row update | NOT RUN; source risk |
| T-019 | Capture ID persistence error cannot create wallet credit without linkage | Mock update error + confirm path | Local Deno/DB mock not built | Confirmation blocked/repair queued | Multiple callers ignore update error; effective RPC has no capture-ID precondition | NOT RUN; source risk |
| T-020 | Razorpay re-quote attempt idempotency key is unique | Static call-chain check | Local source | Attempt-specific key | Current call passes `${registrationId}_${attemptCount}` at `create-payment/index.ts:303-310`; prior finding invalidated | PASS (static) |
| T-021 | Wallet clawback failure becomes payable liability | Debit failure DB fixture | Docker/local DB unavailable | Refund truth and payable balance reconcile | Current RPC logs failure but returns issued; no liability record | BLOCKED; FAIL (source invariant) |
| T-022 | Manual admin payout record/organizer receipt confirmation | UI/schema/function inventory | Local source | Pending/confirmed/disputed/partial states and evidence | No implementation found; withdrawals UI disabled | PASS (gap confirmed) |
| T-023 | Full migration chain/effective RLS/grants/triggers/cron | Sorted `psql -v ON_ERROR_STOP=1 -f` loop in disposable cluster; see T-036 | Docker/Supabase unavailable; plain PostgreSQL only | Effective schema verified | 133 files enumerated; first migration stopped at missing `auth` schema; no effective schema | BLOCKED |
| T-024 | Production financial/provider reconciliation | Authorized read-only exports | No production authorization/data | All ledger/provider records reconcile | No records accessed | BLOCKED |

## Executed local commands

1. `env -i HOME="$HOME" PATH="$PATH" deno test --no-check --allow-read=./supabase --allow-env=RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY supabase/tests/cancel_checkout_interleavings.test.ts supabase/tests/refund_debt_g02.test.ts supabase/tests/refund_exhaustion.test.ts supabase/tests/refunds_concurrency.test.ts supabase/tests/migration_gate.test.ts` → **36 passed, 0 failed**.
2. `cd apps/mobile && env -i HOME="$HOME" PATH="$PATH" flutter test test/payment_fee_test.dart test/payment_status_message_test.dart` → **19 passed, 0 failed**; plugin warning only.
3. Docker/local Supabase availability check from the prior checkpoint → Docker daemon unavailable; no mutating fixture was attempted.

All mutating/provider tests were either mocked/local or blocked. No real payment, refund, payout, production schema, or production data was touched.

## Validation-phase source-model fixtures

| ID | Scenario / exact fixture | Environment | Expected | Actual | Status / limitation |
|---|---|---|---|---|---|
| T-025 | PAY-006: pending payment with null provider ID plus ignored update error; then modeled confirmation | External temporary Deno test, in-memory | No confirmation/credit without durable provider ID | Status became `success`, wallet `1`, provider ID stayed null | PASS (source-model); no Edge Function/DB transaction |
| T-026 | REF-001: successful payment, wallet 1000, simulated debit failure, processed refund | External temporary Deno test, in-memory | Refund and payable balance remain reconcilable through liability | Refund processed, wallet stayed 1000, liability absent | PASS (source-model); no SQL execution |
| T-027 | PAYOUT-004: stale webhook snapshot, wallet restore, failed payout, stale success write | External temporary Deno test, in-memory | Delayed success cannot overwrite terminal failure/restoration | Payout ended `success` while wallet remained restored at 1000 | PASS (source-model); no concurrent Postgres execution |
| T-028 | Repeat lifecycle with registration A/refund A followed by registration B/refund B | External temporary Deno test, in-memory | Histories and provider refunds remain distinct | refund-A and refund-B remained correctly linked | PASS (source-model); no database fixture |
| T-029 | Organizer cancellation list: paid non-attendee, paid attendee, unpaid registration | External temporary Deno test, in-memory | Refund only successful non-attendee | Exactly that result | PASS (source-model); no authorization/provider runtime |
| T-030 | AUTH-001: two reads both observe `checked_in=false` | External temporary Deno test, in-memory | Exactly one scan succeeds | Modeled successes = 2 | PASS (source-model defect reproduction); no concurrent DB execution |
| T-031 | Cross-organizer caller community A versus ticket community B | External temporary Deno test, in-memory | Mismatch denied before RPC | Equality false; source authorization present | PASS (source-model); no RLS/HTTP fixture |
| T-032 | Cashfree source assertions for transfer/webhook/poller/cron/reconcile/env names | External temporary Deno test, repository reads | Residual reachability surfaces identified | All required references found | PASS (source inventory); does not prove hosted deployment or secret presence |

### Execution record

- Test file: `/Users/shivapraneeth/.claude/projects/validation-phase-20261030.test.ts` (outside repository).
- Result after one corrected assertion: **8 passed, 0 failed**.
- Initial failure: exact search for `await supabase.rpc("confirm_payment"` did not match multiline source formatting; stable token assertion was used on rerun.
- These T-025–T-032 results do not substitute for blocked runtime tests T-002, T-012–T-015, T-019, T-021, T-023, and T-024.

## REAL isolated runtime validation phase

| ID | Exact command / fixture | Environment and isolation | Assertions / actual result | Status / limitation |
|---|---|---|---|---|
| T-033 | `docker info`; `supabase status` | Host check only; no mutation | Docker daemon unavailable; Supabase CLI could not access its bundled binary | BLOCKED; no local Supabase runtime |
| T-034 | `psql -h /tmp -p 5432 -d postgres -Atqc ...` listing databases | Existing Homebrew PostgreSQL, read-only inspection | Found `cfu_db`, `orbit`, `postgres`, `smartmilk`; server was not audit-created | BLOCKED for writes; deliberately not used |
| T-035 | `initdb ...`; `pg_ctl ... -k <private-socket> -p 55439 -h ''`; identity SQL; teardown | Fresh temporary PostgreSQL cluster under external project temp directory; private Unix socket; synthetic empty database; no network listener | Identity/data directory/port/socket verified; cluster stopped and directory removal verified | PASS (isolation setup only), not Supabase integration |
| T-036 | Loop sorted 133 migrations with `psql ... -v ON_ERROR_STOP=1 -f <file>` | T-035 disposable cluster only | First file `202607220001_initial_schema.sql` failed at line 31: `ERROR: schema "auth" does not exist`; 0 migrations applied and 0 application objects remained | BLOCKED; exact migration-chain failure, no source bypass |
| T-037 | Booking/refund/rebooking DB fixture | No effective application schema after T-036 | Not executed; no synthetic modeled substitute used | BLOCKED (T-002); requires Supabase runtime/schema |
| T-038 | Organizer cancellation/refund transition fixture | No effective application schema/provider mock harness | Not executed; no synthetic modeled substitute used | BLOCKED (T-007/T-008/T-010) |
| T-039 | Mocked non-throwing persistence failures for Edge Functions | No injectable handler harness; handlers construct module-level Supabase clients and provider calls | Not executed; source-model T-025 remains separately labeled | BLOCKED (T-013/T-018/T-019); no application source changed |
| T-040 | Two-session payout/refund overlap with barriers | No effective `payout_items` schema/RPC | Not executed; no in-memory replacement counted | BLOCKED (T-012/T-021) |
| T-041 | Two-session concurrent check-in with barriers | No effective check-in schema/RPC | Not executed; no modeled replacement counted | BLOCKED (T-014) |
| T-042 | Server-side cross-organizer HTTP/RLS fixture | No local Supabase Auth/Edge/HTTP stack | Not executed; source authorization remains static evidence only | BLOCKED (T-015) |
| T-043 | Production/provider reconciliation | No production authorization/data; no provider calls permitted | Not executed | BLOCKED (T-024) |

### Runtime-phase execution record

- The only mutating runtime operation was against the newly initialized temporary PostgreSQL cluster T-035; no existing local database, linked Supabase project, production credential, provider, or application data was used.
- The cluster was torn down after the migration failure; private socket, process, and temporary data directory removal were verified.
- T-035 is an isolation setup pass only. T-036 and all dependent application scenarios are blocked by the missing Supabase `auth` schema/services. No runtime, database, concurrency, or production test is represented as passed.

## Docker/Supabase blocker diagnosis

| ID | Exact command | Environment | Actual result | Status / next action |
|---|---|---|---|---|
| T-044 | `docker version`; `docker compose version`; `docker context show`; `docker info`; `docker desktop status` | Installed local Docker CLI, `desktop-linux` context | Client/server `29.4.3`, API `1.54`, Compose `v5.1.3`, Docker Desktop `4.73.0`; engine is now reachable and status is `running` | PASS (environment health only); unrelated containers were not used |
| T-045 | `find /Applications/Docker.app ...`; process and launch-agent inspection; `docker ps` | Local installation/process inspection, read-only | Docker backend/virtualization processes are running; unrelated `svhd/logto` and `caddy` containers exist; no container/volume contents inspected | PASS (diagnostic only); existing resources remain out of scope |
| T-046 | `supabase --version`; `supabase status`; inspect installed package and bundled binary | Global Supabase CLI package | Package `2.105.0` and arm64 binary installed; commands still terminate with `SIGKILL` and no output | BLOCKED; user must repair/reinstall or provide working CLI; no package mutation attempted |
| T-047 | `npx --yes supabase --version` (prior attempt, not repeated) | npm cache, no project or production target | Prior `ENOTEMPTY` cache rename error; no package change performed | BLOCKED; not retried automatically |
| T-048 | `open -a Docker` (prior attempt) | Local service start attempt | Prior execution-policy denial; Docker is now running, but start provenance is not assumed | HISTORICAL; no new start action performed |

No Supabase project was initialized, no migration was run, and no runtime fixture was substituted. Existing local PostgreSQL, unrelated Docker containers/volumes, and all remote/production targets remained untouched.

| T-049 | `mkdir -p ... && npm install --prefix "$HOME/.claude/tools/supabase-2.122.0" --global supabase@2.122.0 && .../bin/supabase --version` | New user-owned prefix, proposed but not executed | Execution policy denied external package download/execution; no files or package state changed | BLOCKED; user must run the exact pinned command outside the restricted session or provide a verified binary |

