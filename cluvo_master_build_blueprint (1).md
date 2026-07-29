# CLUVO — MASTER BUILD BLUEPRINT

Version: 1.0

## Purpose
Master engineering handbook and build plan for Cluvo.

## Technology
- React Organizer Portal
- React Admin Portal
- Flutter Mobile App
- Supabase (Auth, PostgreSQL, Storage, Realtime, Edge Functions)
- Razorpay
- Firebase Cloud Messaging
- OpenStreetMap

## Core Rules
- Documentation First
- Database First
- Security First
- Never trust the client
- RLS on every table
- Migrations are the only schema source
- Edge Functions for complex writes
- Business logic stays out of UI

## Architecture
Flutter/React
→ Service
→ Repository
→ Direct Supabase Reads (RLS)
OR
→ Edge Functions
→ PostgreSQL

## Folder Structure
community-os/
- apps/
  - mobile
  - organizer-web
  - admin-web
- packages/
  - shared
  - ui
  - config
- supabase/
  - migrations
  - functions
  - seed
- docs/
- scripts/

## Development Order
1. Repository
2. Supabase Project
3. CLI + Environment
4. Database
5. RLS
6. Edge Function foundation
7. Authentication
8. Communities
9. Events
10. Bookings
11. Payments
12. Notifications
13. Reviews
14. Search
15. Analytics
16. Flutter App
17. Organizer Portal
18. Admin Portal
19. Production Hardening

## Parallel Roles
Database Engineer:
- Schema
- Migrations
- Constraints
- Indexes
- RLS

Backend Engineer:
- Edge Functions
- Transactions
- Validation
- Logging
- Integrations

Flutter Engineer:
- Mobile UI
- Authentication
- Booking
- Profile

Organizer Web Engineer:
- Community Management
- Events
- Registrations

Admin Engineer:
- Moderation
- Reports
- Settings

UI/UX:
- Design System
- Components

QA:
- Unit
- Integration
- Security
- Accessibility

DevOps:
- CI/CD
- Secrets
- Monitoring
- Backup

## Read / Write Rule
Direct Reads:
- Communities
- Events
- Search
- Registrations (RLS)

Edge Functions:
- Create Community
- Create Event
- Booking
- Payments
- Refunds
- Team Management

## Module Template
Purpose
Actors
Business Rules
State Machine
Database
RLS
Edge Functions
UI
Validation
Testing
Future Scope

## Edge Function Flow
Validate
Authenticate
Authorize
Business Validation
Transaction
External APIs
Audit
Response

## Definition of Done
- Docs updated
- Migration written
- RLS complete
- Backend complete
- UI complete
- Tests pass
- Code reviewed

## Milestones
M0 Infrastructure
M1 Database
M2 Backend Foundation
M3 Authentication
M4 Communities
M5 Events
M6 Bookings
M7 Payments (MVP)
M8 Frontends
M9 Production
M10 Launch

## Golden Rules
1. Documentation before code.
2. Database before UI.
3. Never bypass services.
4. Never expose secrets.
5. Verify payments server-side.
6. Every permission in RLS.
7. Use migrations only.
8. Keep modules independent.
9. Test before merge.
10. Architecture over shortcuts.

---

## BEFORE BUILDING ANYTHING — READ THIS ACTIVELY, EVERY TIME

> **Instruction to the AI building this project:** Before writing a single line of code, migration, or UI component for any task, actively read the four perspectives below — not as passive background context, but as four reviewers who must each sign off before you proceed. If any one of them would object, stop and raise it instead of building. Re-read this section at the start of every new task, not just once at project start. Treat it as a gate, not a preamble.

### 🏗️ Backend Architect — asks before any schema or Edge Function is written:
- Does this table already have RLS enabled, with an explicit policy — not "I'll add it after"?
- Is this a direct read or does it genuinely need an Edge Function? (Check the Read/Write Rule above — don't default to Edge Functions out of caution; that costs invocation budget and adds latency for no reason.)
- Is this write atomic and idempotent? If it touches money or capacity (bookings, payments, waitlist), what happens if this exact request arrives twice?
- Am I re-checking permissions explicitly inside the Edge Function, even though RLS also exists? (Both layers check. Always.)
- Does this follow the Edge Function Flow exactly: Validate → Authenticate → Authorize → Business Validation → Transaction → External APIs → Audit → Response — or am I skipping a step because it "seems fine this time"?
- Am I about to hardcode an assumption this project explicitly said not to (one organizer, one payment provider, one notification provider)?

### 🎨 UI/UX Designer — asks before any screen or component is built:
- Does this screen define all four states — Loading, Empty, Error, Success — or am I only building the happy path?
- Is this accessible — labeled, sufficient contrast, sensible focus order — not just visually correct?
- Am I reusing an existing component from `packages/ui`, or am I quietly duplicating one because it was faster in the moment?
- Does this match the platform convention — mobile-first patterns in Flutter, web dashboard patterns in React — rather than copy-pasting one platform's UI logic into the other?
- If this is a form or flow a Community Manager or Admin will use daily, is it fast and low-friction, not just "technically complete"?

### 📋 Key Project Manager — asks before any task is marked done:
- Does this actually satisfy the Definition of Done — docs updated, migration written, RLS complete, backend complete, UI complete, tests pass — or are 2 of 6 boxes being quietly skipped because the feature "basically works"?
- Is this task in scope for the current milestone (M0–M10), or is this scope creep — building something from a later milestone because it seemed easy right now?
- Does this module have its Module Template filled out (Purpose, Actors, Business Rules, State Machine, Database, RLS, Edge Functions, UI, Validation, Testing, Future Scope) before being considered started, not just before being considered finished?
- If this is genuinely blocked or ambiguous, is that being flagged clearly, instead of a guess being silently built and shipped?

### 💰 CFO — asks before any infrastructure choice or third-party call is added:
- Does this consume Edge Function invocations, storage, or egress unnecessarily, given we're validating on Supabase's free tier?
- Is this the cheapest reasonable option that still meets the Security First and Never Trust the Client rules — not the fanciest one?
- If this integrates a paid service (Razorpay, FCM), is usage being called only where genuinely needed, not sprinkled in as a convenience?
- Does this decision assume unlimited budget/scale, when the actual constraint is: solo builder, free-tier-first, no committed funding yet?
- If this were to succeed and scale 10x, is there a known, sane upgrade path (Supabase Pro, etc.) — or does this choice quietly lock us into an expensive corner?

---

**Operating instruction, restated plainly:** these four voices are not decoration at the bottom of a document. Before generating code for any task in the Development Order above, actively check the task against all four. If two or more would raise a concern, stop and state the concern instead of proceeding — do not silently choose the convenient interpretation and keep building.