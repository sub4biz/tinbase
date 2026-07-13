# tinbase roadmap

## North Star

**A developer can run `tinbase start` instead of `supabase start` and build almost any app without noticing the difference — no Docker, one process, real Postgres.**

The measure of success is not a feature checklist; it is: *take a real Supabase project, point supabase-js at tinbase, and everything the app does just works.*

## Scope: what we match, and what we deliberately don't

tinbase targets **the local Supabase development stack** (`supabase start`), not Supabase Cloud the company.

**In scope** (this is what "almost everything" means):

- Postgres + the extensions Supabase enables locally
- REST (PostgREST), Auth (GoTrue), Storage, Realtime, Edge Functions
- Studio, migrations, seed, type generation, local email testing
- The behaviors, error shapes, and defaults a local Supabase project relies on

**Out of scope** (Cloud platform, not local dev — never our goal):

- Hosting, projects/org management API, billing
- Supavisor connection pooling, read replicas, HA/PITR
- Branching against a remote, Logflare cloud analytics
- Anything you cannot get from `supabase start` today

Keeping this line bright is what keeps the goal achievable. When unsure whether
to build something, ask: *does `supabase start` give it to a developer locally?*
If no, it's out of scope.

## Definition of done: the parity harness

The durable, objective measure (build this early — it makes every later phase self-checking):

- A suite that runs the **same** supabase-js programs against (a) a real `supabase start` stack and (b) tinbase, and **diffs the results** — data, status codes, error codes, headers.
- A conformance report: “X of Y behaviors match.” That number, not our own estimate, becomes the scoreboard.
- Green parity on a scenario = that scenario is genuinely 1:1.

Until the harness exists, coverage numbers below are our own honest estimates.

## Current state (v0.9.0)

| Module | Coverage | Biggest gaps |
| --- | --- | --- |
| Database (PostgREST) | ~95% | aggregates *within embeds*; error-shape parity (harness) |
| Auth (GoTrue) | ~90% | SSO, phone auth |
| Storage | ~90% | image transforms served as no-op (real resize needs a codec) |
| Realtime | ~90% | per-row DELETE RLS (WALRUS) |
| Edge Functions | ~85% | remote-import fetch needs network at first run |
| Studio | ~80% | table/column designer UI |
| Type generation | ~85% | composite-type args, multi-schema output |
| Extensions (pgvector, pg_cron, pg_net, pgmq) | cron, pg_net, pgmq, webhooks emulated; pgvector 0% | pgvector vector search (needs a bundled binary) |

Typical CRUD + auth + storage + realtime app: **~90%** already works.

## Phases (ordered by real-app impact)

Each phase ships independently, keeps 100% test green on both engines, and moves
the "runs my real app" bar forward. Check items off as they land.

### Phase 0 — Parity harness (infrastructure)
- [x] Shared scenario programs (supabase-js) — `parity/scenarios.ts`
- [x] Self-scored harness runs against tinbase on both engines — `npm run parity` (14/14)
- [x] `--compare` diffs normalized results against a real `supabase start` (needs Docker)
- [ ] Wire `--compare` into CI as an informational job (once a CI Docker path is set up)

### Phase 1 — Auth completeness (the #1 real-app blocker)
- [x] OAuth providers (Google, GitHub presets + generic) — `signInWithOAuth()` end to end
- [x] PKCE flow (`exchangeCodeForSession`)
- [x] MFA / TOTP enroll + challenge + verify (aal2 elevation; `factors` on the user; QR + otpauth URI)
- [x] Identity linking by email (auth.identities); [x] anonymous → permanent upgrade (updateUser adds email/password, keeps uid, records email identity)
- [x] Local email inbox UI (like Inbucket/Mailpit) for magic-link/OTP testing — captured in-memory, served at `/inbox`
- Target: Auth ~65% → ~90%

### Phase 2 — Realtime correctness
- [x] RLS-filtered `postgres_changes` (INSERT/UPDATE by PK re-query; DELETE limited — see note)
- [x] Private channels with authorization (RLS on realtime.messages via realtime.topic(); read=subscribe, write=broadcast)
- [x] Broadcast-from-database (realtime.send(payload, event, topic, private) → topic subscribers)
- Target: Realtime ~70% → ~90%; closes a real security gap ✓

### Phase 3 — Developer experience
- [x] `tinbase gen types typescript` from the live schema
- [x] `db reset` (wipe + re-run migrations/seed); [x] `db diff` (schema differ); [x] `db pull` (delta → migration, marked applied); [x] `inspect` (per-table rows + size)
- [x] Studio: RLS policy editor, functions/triggers browser; [x] logs pane (server log buffer + /admin/v1/logs)
- Target: match the daily-driver DX of the Supabase CLI + Studio

### Phase 4 — Extensions & automation
Finding: pgvector/pg_net/pg_cron/pgmq are third-party C extensions NOT present
in the theseus native Postgres binaries or this PGlite build. Two tracks:
- [ ] Bundle extension binaries (pgvector first) for native across platforms +
      a PGlite build that includes them — infra project, needed for true pgvector
- [x] tinbase-native automation that needs no C extension, works on both engines:
      - [x] database webhooks (CDC → HTTP) — the Supabase webhook payload shape
      - [x] scheduled jobs (in-process cron running SQL) — replaces pg_cron; matches in UTC
      - [x] HTTP from SQL (net.http_post/get/delete → in-process sender) — pg_net emulation, so a cron job or trigger can call an Edge Function / any URL
      - [x] table-backed queue helpers (pgmq.* subset) — replaces pgmq
- Target: AI + automation apps run unchanged

### Phase 5 — Edge Functions runtime fidelity
- [x] Deno-compatible execution via a Deno.serve/Deno.env shim (functions using
      Web APIs run unchanged; npm:/jsr:/URL imports still need bundling)
- [x] Resolve npm:/jsr:/URL import specifiers — esbuild bundling; npm:/jsr: rewritten to esm.sh, https imports fetched + disk-cached (TS + relative imports also bundle)
- [x] Function secrets — supabase/functions/.env → Deno.env + ctx.env (local `--env-file` parity)
- Target: real Supabase functions run with no edits

### Phase 6 — Storage & PostgREST fidelity edges
- [x] Storage resumable (TUS) uploads — TUS 1.0.0 creation, creation-with-upload,
      core PATCH, and termination; upload state held in memory (resumes within a
      server session), finalized through the normal object-write path
- [ ] Storage image transformations — interim **no-op**: transform requests
      (`/render/image/{public,authenticated,sign}/…`) serve the *original* object
      (with a one-time warning) so apps don't 404. Real resize/re-encode still
      needs a bundled image codec (a poor fit for the no-deps / browser model)
- [x] PostgREST aggregates-in-select (`count()`/`sum()`/`avg()`/`max()`/`min()` +
      implicit group by), `.explain()` (text/json plans), `.csv()`, and to-one /
      to-many / m2m spread embeds — top-level aggregates only (not yet within embeds)
- [ ] Error-shape matching verified by the parity harness

### Phase 7 — Connect to an external Postgres (community request)
Requested on X: *"Would be nice if it could use an external PG instance."* Point
tinbase's REST, Auth, Storage, and Realtime at a Postgres you already run
instead of the embedded PGlite/native engine.
- [x] A `--database-url postgres://…` (and `createBackend({ databaseUrl })`)
      engine: a `DbEngine` adapter over the wire protocol, so nothing above the
      adapter changes. Reuses `PgWireClient` + a shared `buildWireEngine`; added
      cleartext/md5/**SCRAM-SHA-256** auth for TCP. Verified against a real
      Postgres launched on TCP with SCRAM (no Docker).
- [x] Treat the target as shared/pre-existing: bootstrap runs idempotently and
      migrations/seed stay tracked in `supabase_migrations`, so a second boot
      against the same database neither errors nor re-applies. Never assumes an
      empty DB or exclusive ownership.
- [ ] Bonus — a BYO Postgres that already has `pg_cron` / `pg_net` / `pgvector`
      gives you those for real, an alternative to bundling extension binaries
      (Phase 4). (Largely implied now — migrations using them run as-is.)
- Deferred follow-ups: **TLS / sslmode** (needed for most managed PGs — Neon,
  Supabase, RDS); realtime CDC without superuser/replication rights; connection
  pooling (single-writer today); provisioning the target's `anon`/`authenticated`
  roles when absent.
- Boundary: this is "bring your own local/dev Postgres," not managing a remote
  Supabase Cloud project — hosting/pooling/replicas stay [out of scope](#scope-what-we-match-and-what-we-deliberately-dont).

## Working principles (so the goal survives across sessions)

1. **Every change keeps the full suite green on both engines** (`npm test` and `TINBASE_TEST_ENGINE=native npm test`).
2. **Every new surface gets a test written against the real supabase-js**, not a bespoke client.
3. **Prefer real Postgres/extension behavior over shims** where the engine supports it; shim only for cross-engine (browser) parity.
4. **Update the coverage table here** when a phase item lands, so this file is always the current truth.
5. **When a real project reveals a gap** (like the uuid-ossp and stale-pid fixes did), add a regression test and, if it points to a whole missing area, a roadmap item.

## How to pick up work

Read this file → find the first unchecked item in the lowest-numbered phase →
build it → keep the suite green → check it off and update the coverage table.
