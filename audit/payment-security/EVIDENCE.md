# Evidence Log — Fresh Rescan

## EV-001 — Repository and worktree
- Repository root: `/Users/shivapraneeth/Documents/community`.
- Branch: `dev`; HEAD: `59eea61ddbb622d1fd11a42719c66c3da4e6ca30`.
- Initial status had pre-existing untracked `.agents/`, `.opencode/`, `audit/`, `deno.lock`, and `skills-lock.json`; no application source was changed by this audit.
- `apps/mobile/`, `apps/organizer-web/`, `apps/admin-web/`, `supabase/functions/`, `supabase/migrations/`, and `supabase/tests/` are present and readable.

## EV-002 — Current provider and Flutter caller chain
- `apps/mobile/lib/screens/event_detail_screen.dart:675-755` invokes `create-payment`, receives a server-generated Razorpay order/amount, and opens Razorpay checkout.
- `apps/mobile/lib/screens/event_detail_screen.dart:739-755` starts a safety timer and uses server resolution after lost callbacks.
- `supabase/functions/create-payment/index.ts:28-55,257-356` creates Razorpay orders and persists order state; `:303-310` passes registration plus attempt count into order creation.
- `supabase/functions/verify-payment/index.ts:48-77,166-181` checks Razorpay order/payment state and invokes `confirm_payment`.
- `supabase/functions/verify-payment-webhook/index.ts:184-232,235-280` verifies Razorpay HMAC, deduplicates events, finds the order, confirms payment, and starts claim-guarded refunds.
- `supabase/functions/_shared/refunds.ts:170-290` is the common claim/provider-recheck/refund-completion path.

## EV-003 — Re-quote and payment-ID persistence
- `create-payment/index.ts:28-32` constructs the idempotency key from its argument; `:303-310` passes `${registrationId}_${attemptCount}`, so the earlier PAY-003 registration-only claim is invalidated by current source.
- `create-payment/index.ts:313-330` does not inspect the error returned by an existing payment update after the Razorpay order is created.
- `verify-payment/index.ts:56-60`, `verify-payment-webhook/index.ts:254-263`, `create-payment/index.ts:78-93`, and `cancel-event/index.ts:122-128` similarly write `razorpay_payment_id` without checking the returned query error before confirmation.
- Effective current `confirm_payment` is redefined by `202610290003_confirm_payment_refund_status.sql:118-135`; it marks a payment successful and credits the wallet without a non-null provider capture-ID invariant.

## EV-004 — Cancellation and refund rules
- `cancel-registration/index.ts:46-74` scopes the registration to the authenticated user and rejects at `now >= start - 24h`, including exactly 24 hours.
- `cancel-registration/index.ts:119-142` cancels before refunding and uses the persisted platform-fee split; `:181-188` records failed refund attempts for reconciliation.
- `cancel-event/index.ts:46-88` checks event/community owner, moderator/organizer membership, and admin status.
- `cancel-event/index.ts:107-143` probes pending Razorpay orders during organizer cancellation; `:145-175` excludes attended registrations and refunds successful non-attendees; `:218-240` cancels registrations and the event.
- `202610290003_confirm_payment_refund_status.sql:54-84` prevents confirmation on cancelled registrations/events and assigns refund reasons.
- `202610220004_refund_policy_integrity.sql:250-285,288-324` archives provider refund truth, attempts wallet clawback, logs clawback failure, and still returns issued success.

## EV-005 — Repeat booking/refund design
- `apps/mobile/lib/providers/activity_provider.dart:34-74` merges live payments with `payment_refund_history` so archived refunds survive reuse of a payment row.
- `202610220004_refund_policy_integrity.sql:273-285` inserts history keyed to the old payment/registration/event and uses an idempotent conflict clause for provider refund IDs.
- `create-payment/index.ts:163-213,303-330` blocks paid/refunding rows, archives/clears old refund fields before re-quote, and increments `attempt_count`.
- A real Booking A → Refund A → Booking B → Refund B database fixture was not executed; independent IDs, provider behavior, and final displayed ordering therefore remain runtime-unverified.

## EV-006 — Legacy Cashfree reachability
- `supabase/functions/withdraw-wallet/index.ts:18-72,74-145` authenticates an owner, debits wallet using `initiate_wallet_withdrawal`, and calls Cashfree transfer APIs; timeout handling may retain processing or call `refund_wallet`.
- `supabase/functions/cashfree-webhook/index.ts:12-138` remains a signature-checked external endpoint that mutates payout rows/wallets.
- `supabase/functions/sync-payout-status/index.ts:95-205` has a cron-secret mode and an organizer on-demand mode that can apply Cashfree status transitions.
- `apps/organizer-web/src/components/payout/payout-section.tsx:78-157,222-231,368-420` still subscribes to payout rows, displays Cashfree data, supports status refresh, but disables withdrawals in the visible UI.
- `supabase/migrations/202607280002_wallet_and_payouts.sql:5-20,35-83,107-145` defines Cashfree payout storage, wallet debit, and wallet refund functions.
- `202608170003_payout_status_sync.sql:23-82` defines a locked status RPC and `:94-113` schedules a Cashfree status cron. `202610140004_fix_payout_sync_cron_vault.sql:47-80` unschedules the earlier hard-coded URL job and conditionally reschedules from Vault secrets, but actual deployed cron/Vault state was not available.
- `202610300001_reconcile_cron_2min.sql:8-31` schedules the reconciliation function every two minutes, which still includes legacy payout refund logic.
- No Cashfree path was found in the customer Razorpay checkout/refund lifecycle.

## EV-007 — Payout race and safety-net evidence
- `reconcile-payments/index.ts:486-515` has an earlier sweep that excludes processing rows without a real `wd_` ID, but `:517-540` separately refunds every processing row older than 24 hours without provider lookup.
- `cashfree-webhook/index.ts:58-76` reads without locking; `:76-106` can miss a clawback after a concurrent wallet refund and write success.
- `202608170003_payout_status_sync.sql:23-72` demonstrates the safer `FOR UPDATE` transition path used by the poller.

## EV-008 — Ticket authorization and concurrency
- `check-in/index.ts:47-103` resolves QR → event → community before mutation and checks owner/team/admin authorization; unknown/deleted QR returns 400.
- `202610090001_check_in_security.sql:86-87` revokes direct client execution and grants the check-in RPC only to service role.
- `202610090001_check_in_security.sql:25-32,57-80` performs a non-locking read followed by an unconditional registration update. The edge authorization control is positive evidence against the inspected cross-organizer bypass, but it does not make attendance exactly-once.

## EV-009 — Manual payout gap
- `apps/organizer-web/src/components/payout/payout-section.tsx:222-231` says withdrawals are unavailable.
- Repository search found no admin manual transfer record/confirm UI, organizer receipt-confirmation state, event allocation model, dispute state, or manual payout RPC/table. Existing `payout_items` is Cashfree/provider-shaped.
- Existing wallet statement (`supabase/functions/get-wallet-statement/index.ts:36-67` and `202607300016_wallet_statement_accurate_balance.sql:26-99`) derives from wallet audit plus provider payout rows; it does not represent pending/confirmed manual transfers or receipt confirmation.

## EV-010 — Configuration and secrets safety
- `supabase/.env`, `apps/admin-web/.env`, and `apps/admin-web/.env.local` are ignored by git (`.gitignore`/app `.gitignore`); they were not read for values. A targeted name-only search confirms Razorpay and Cashfree environment names.
- The local `supabase/.env` contains non-placeholder provider configuration including a Razorpay test credential; exact values are intentionally omitted. Production exposure cannot be inferred from the ignored local file.
- `202608170003_payout_status_sync.sql` contains a historical hard-coded cron URL/secret in the old migration; `202610140004_fix_payout_sync_cron_vault.sql:3-19,47-80` documents the replacement and required rotation, but rotation/deployment was not verified. No secret value is reproduced here.

## EV-011 — Executed tests
- Command: `env -i HOME="$HOME" PATH="$PATH" deno test --no-check --allow-read=./supabase --allow-env=RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY supabase/tests/cancel_checkout_interleavings.test.ts supabase/tests/refund_debt_g02.test.ts supabase/tests/refund_exhaustion.test.ts supabase/tests/refunds_concurrency.test.ts supabase/tests/migration_gate.test.ts`
- Result: **36 passed, 0 failed**. These are local source/mocked tests; no gateway/network/database mutation occurred.
- Command: `cd apps/mobile && env -i HOME="$HOME" PATH="$PATH" flutter test test/payment_fee_test.dart test/payment_status_message_test.dart`
- Result: **19 passed, 0 failed**. Flutter warned that `razorpay_flutter` lacks Swift Package Manager support; no gateway was contacted.

## EV-012 — Blocked validations
- Docker was unavailable (`Cannot connect to the Docker daemon`); local Supabase/Postgres was not running.
- Therefore no disposable migration-chain execution, effective-schema inspection, concurrent payout/check-in fixture, cross-organizer request fixture, repeat-booking DB fixture, or mocked non-throwing persistence-error fixture was executed.
- No production database, hosted Supabase, Razorpay, Cashfree, customer identity, or financial record was contacted.
- Delegated Explore agents failed before producing results due upstream `HTTP 400 Unsupported parameter: temperature`; no agent output is treated as evidence.

## EV-015 — Docker and Supabase CLI blocker diagnosis
- Docker CLI installation is present: `docker version` reports client `29.4.3`, API `1.54`; `docker compose version` reports `v5.1.3`; active context is `desktop-linux`.
- Docker engine is unavailable: `docker info` reports `Cannot connect to the Docker daemon at unix:///Users/shivapraneeth/.docker/run/docker.sock`. `docker desktop status` reports Docker Desktop is not running. The Docker Desktop application bundle exists at `/Applications/Docker.app`; the Docker backend/helper artifacts exist, but no running engine process was found. The `com.docker.vmnetd` helper alone is not the engine.
- The approved local-service start attempt, `open -a Docker`, was denied by the execution policy because starting Docker Desktop persists a background system service. Docker was not started through a workaround.
- Supabase CLI installation is present at `/opt/homebrew/lib/node_modules/supabase`, package version `2.105.0`, with `/opt/homebrew/bin/supabase` pointing to its Node shim and an arm64 bundled binary. `supabase --version` and `supabase status` terminate while invoking the bundled binary; Node reports signal `SIGKILL` and no CLI output. The binary is arm64 Mach-O and ad-hoc signed. No alternate Bun runtime is installed.
- `npx --yes supabase --version` was not used as a repair path; it returned npm `ENOTEMPTY` while renaming its cached platform package. No package installation or replacement was performed.
- Required next action: the user must repair/reinstall or provide a verified working Supabase CLI `2.105.0`-compatible binary. Until `docker info` and `supabase --version` both succeed, no local Supabase project or migration command is safe to run.

## EV-016 — Current environment recheck and isolation proposal
- Current Docker health check: `docker version`, `docker compose version`, `docker context show`, and `docker info` now succeed. Docker client/server are `29.4.3`, API `1.54`; Docker Desktop server is `4.73.0 (226246)`; Compose is `v5.1.3`; context is `desktop-linux`.
- Docker is no longer the immediate blocker. Read-only process inspection found the Docker backend/virtualization processes running. `docker ps` showed unrelated running `svhd/logto:1.41.0` and `caddy:2-alpine` containers. Existing Docker volumes included unrelated application data and names resembling Supabase resources; no volume contents were inspected and no container, volume, network, or database was changed.
- Current toolchain versions: Node `v22.23.0`, npm `10.9.8`, Deno `2.9.8`. Supabase package remains `2.105.0` at `/opt/homebrew/lib/node_modules/supabase`, but `supabase --version` and `supabase status` still terminate with `SIGKILL` before output. No package repair, cache deletion, `npx` retry, or Homebrew mutation was performed.
- Safest isolation plan: user repairs/provides a working pinned Supabase CLI first; then initialize a fresh temporary project outside the repository with no `supabase link`, verify Docker context, project directory, container names, local ports, generated local database/API identity, and only then run `supabase start`, migrations, and tests. Existing containers, volumes, `/tmp:5432` PostgreSQL, linked metadata, remote projects, and production must remain untouched.
- No migration, local Supabase project, database write, provider call, or production action was performed in this recheck.

## EV-017 — Approved isolated CLI repair blocked by execution policy
- Proposed command (not executed): `mkdir -p "$HOME/.claude/tools/supabase-2.122.0" && npm install --prefix "$HOME/.claude/tools/supabase-2.122.0" --global supabase@2.122.0 && "$HOME/.claude/tools/supabase-2.122.0/bin/supabase" --version`.
- Rationale: install a clean, exact-version CLI in a new user-owned prefix without deleting or overwriting the orphaned `/opt/homebrew` package or changing `PATH`.
- Execution result: the session execution policy denied the command because it would download and execute external package code. The command did not run, the directory was not created by this attempt, and the existing installation was not changed.
- Safe next action: the user must run the pinned command outside the restricted session or provide a verified absolute Supabase CLI binary. Afterward, verify its version and signature/health before initializing any local project.

## EV-013 — Validation phase source-model fixtures (executed)
- Test file: `/Users/shivapraneeth/.claude/projects/validation-phase-20261030.test.ts`; it is outside the repository and did not modify application or audit source.
- Result: **8 passed, 0 failed** after correcting one initial source-string assertion from an over-specific multiline literal to the stable `rpc("confirm_payment"` token.
- Fixtures covered: ignored provider-ID persistence before confirmation; wallet debit failure after refund truth; stale payout SUCCESS after wallet restoration; distinct repeat-booking refund history; organizer cancellation eligibility; two modeled concurrent check-in successes; cross-organizer mismatch denial; and source inventory of Cashfree transfer/webhook/poller/cron/reconcile/environment references.
- The modeled outcomes were: success with `razorpay_payment_id=null`; processed refund with unchanged wallet and no liability; local payout `success` with restored wallet; distinct refund-A/refund-B history; refund only for paid non-attendee; two apparent check-in successes; authorization mismatch denied; and all six Cashfree source surfaces found.
- Limitation for all eight: no Edge Function invocation, Supabase/Postgres transaction, RLS/grant evaluation, actual concurrent execution, provider request, hosted deployment check, or financial record access occurred. These are source-model/static validation results and cannot change the audit's INCOMPLETE status.

## EV-014 — Runtime environment and migration-chain validation
- Outstanding matrix items were re-read before testing: T-002, T-007/T-008/T-010, T-012–T-015, T-018/T-019/T-021, T-023, and T-024 remained runtime-blocked; T-003 remained partial and T-013 remained not run.
- `docker info` failed with `Cannot connect to the Docker daemon at unix:///Users/shivapraneeth/.docker/run/docker.sock`; `supabase status` also failed while the CLI attempted to access its bundled binary. No Supabase container or linked project was used.
- A read-only check found Homebrew PostgreSQL 16 accepting connections on `/tmp:5432`, but databases `cfu_db`, `orbit`, `postgres`, and `smartmilk` already existed. Because that server was not created for this audit, it was not used for writes.
- Exact disposable-cluster command: `initdb -D <temporary-data> --no-locale --encoding=UTF8 --auth=trust`; `pg_ctl -D <temporary-data> -o "-k <private-socket> -p 55439 -h ''" ... start`; SQL identity assertion queried `current_database()`, `current_user`, `data_directory`, `port`, and `listen_addresses`. The result was a new `postgres` database, local audit user, temporary data directory, port `55439`, and empty listen-address setting. The process and private socket were verified, then `pg_ctl ... stop -m immediate` and removal of the temporary directory were verified.
- Exact migration-chain command iterated all sorted `supabase/migrations/*.sql` files with `psql -h <private-socket> -p 55439 -d postgres -v ON_ERROR_STOP=1 -f <migration>`. Inventory count was **133**. It failed at migration `202607220001_initial_schema.sql`, before any migration completed, with `ERROR: schema "auth" does not exist` at line 31. The disposable database had zero application schema objects after the failed attempt and was torn down.
- T-023 is therefore **BLOCKED**, not passed. The repository migration chain requires Supabase-provided schemas/services; a plain isolated PostgreSQL cluster cannot establish effective Supabase schema, RLS, grants, triggers, or cron behavior. No migration was edited to bypass the failure.
- Because no effective application schema was available, T-002, T-007/T-008/T-010, T-012, T-014, T-015, T-021, and T-023 could not run as database/runtime tests. T-024 remains blocked because production/provider data and credentials were not accessed.
