# Social Issues App

A case-agnostic engine for walking people through a public controversy one
sourced fact at a time, in plain words. A reader rates one statement from
Disagree to Agree, reads the facts in a fixed order and says whether they agree
with a short statement about each, sees how the left, the center and the right
are telling the story online (with each claim checked), then rates the
statement again and sees how they moved compared with everyone else.

Adding a new controversy means running the agent pipeline and approving its
package in the admin console. It never means writing app code.

The build spec is [`docs/SPEC.md`](docs/SPEC.md).

## The three parts

| Part | Where | What it does |
| --- | --- | --- |
| Dive app | `apps/mobile` (Expo, iOS / Android / web) | Plays any published case. Records answers; shows reveals and the share card. |
| Agent pipeline | `services/pipeline` (Claude Agent SDK) | Researches a brief, drafts the dive, attacks its own draft, submits a package for review. |
| Admin console | `apps/admin` (Next.js) | The owner reviews each package: preview, inline edits, balance, audit trail, diff, approve / schedule / request changes / reject. |

Shared code:

| Package | Purpose |
| --- | --- |
| `packages/case-schema` | Zod case schema (the single source of truth), validator, public projection, balance check, seed profiles, diff |
| `packages/case-store` | Typed Supabase data access for staff (admin, pipeline, import) |
| `packages/dive-engine` | Screen sequence and state machine, crowd wire types, Supabase and in-memory APIs |
| `packages/dive-ui` | React Native screens, used by the app and by the admin preview (react-native-web) |
| `supabase/` | Migrations, row-level security, crowd functions, scheduled jobs, import scripts, DB tests |
| `cases/seed` | The hand-checked Cornell seed case, its research log and draft seed profile |
| `cases/fixtures` | Two fictional cases used to prove the engine is case-agnostic |

## How the guarantees are enforced

- **Only the owner publishes.** Staff sign in with Supabase Auth. Their role
  (`admin` or `pipeline`) lives in `app_metadata`, which only the service role
  can set. Row-level security lets the pipeline write drafts and in-review
  versions, never published ones. A guard trigger refuses any publish that does
  not come from an admin action, even from the service role. Scheduled
  publishes need an approval of the exact content approved (content hash).
- **Published versions are immutable.** Edits create a new version (tagged
  `admin_edit`). Responses stay tied to the version a reader saw. Aggregates
  are always per version.
- **The public sees only published, projected documents.** `favors`, `impact`,
  `evidence` and the review record never leave the database for the public;
  the projection is an allowlist, mirrored in TypeScript and tested for parity.
- **Publishing is blocked on any schema error.** The database checks the full
  JSON Schema generated from the Zod schema (`pg_jsonschema`) plus the
  cross-field rules (every step cited, no `established` on news-only sources,
  real sides).
- **The crowd result stays hidden until commit.** The only way to get a step's
  crowd numbers is to commit an answer for it (`submit_response`), or to ask for
  the reveal of a step already answered.
- **Seeded crowd data is flagged.** Seed rows carry `is_seed`, every aggregate
  takes `include_seed`, seeds fade out as real readers finish (case-wide), and
  the app says when numbers include seeds.
- **Abuse floor without login.** One session per device per version, rate
  limits keyed on a platform-set client IP, and sessions finished faster than a
  reading-time floor are dropped from aggregates.
- **Agents cite only what they opened.** Sources are fetched and saved by the
  pipeline's own tool; a deterministic check fails any citation to a page not
  opened in the run and any quote not found word for word in its saved text.
  Every query, page and claim goes to `research_log`.

## Local development

Requirements: Node 22, pnpm 10, Docker (for the local Supabase stack).

```sh
pnpm install
cd supabase && npx supabase start          # Postgres, Auth, REST, cron; applies migrations
```

Create the staff accounts (local service key from `npx supabase status`; the
service key is used only by this setup script, never by the apps or the worker):

```sh
export SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local service key>
pnpm --filter @sia/supabase staff:create --role admin    --email owner@example.com    --password '<12+ chars>'
pnpm --filter @sia/supabase staff:create --role pipeline --email pipeline@example.com --password '<12+ chars>'
```

Import the Cornell seed case. It goes into the review queue; nothing is
published until you approve it in the console:

```sh
export SUPABASE_ANON_KEY=<local anon key> SIA_STAFF_EMAIL=owner@example.com SIA_STAFF_PASSWORD='...'
pnpm --filter @sia/supabase import-case ../cases/seed/cornell.json --seed-profile ../cases/seed/cornell.seed-profile.json
```

Run the parts (each has a `.env.example`):

```sh
# Admin console on http://localhost:3100
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> pnpm --filter @sia/admin dev

# Dive app (press i / a / w for iOS, Android, web)
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon> pnpm --filter @sia/mobile start

# Pipeline worker: claims queued jobs (new case from a brief, revision, update)
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<anon> PIPELINE_EMAIL=pipeline@example.com PIPELINE_PASSWORD='...' \
  pnpm --filter @sia/pipeline worker
```

The worker needs Claude access for the Agent SDK (for example
`ANTHROPIC_API_KEY`). See [`services/pipeline/README.md`](services/pipeline/README.md)
for models, spend caps, how live updates work, and running the worker as a
service (a Dockerfile, next to a hosted Supabase project).

## Tests

| Command | What it covers |
| --- | --- |
| `pnpm -r typecheck` | Every package and app |
| `pnpm --filter @sia/case-schema test` | Schema, validator, projection, balance, seeds, diff |
| `pnpm --filter @sia/supabase test` | RLS, publish guard, immutability, crowd API, seeds, hardening, SQL/TS parity (needs the local stack) |
| `pnpm --filter @sia/dive-engine test` | Flow state machine, in-memory API, both fixtures played through |
| `pnpm --filter @sia/mobile test` | Native and web renderers: full flow for both fixtures, crowd hidden until commit |
| `pnpm --filter @sia/mobile e2e:web` | Chromium against the local stack: both fixtures end to end |
| `pnpm --filter @sia/admin test` / `e2e` | Console logic; Playwright acceptance (edit then approve) against a production build |
| `pnpm --filter @sia/pipeline test` | Pipeline infrastructure, agents, loop rules, worker, fabricated-claim test, live updates (scheduled re-research to a revision in review) |
| `pnpm --filter @sia/pipeline e2e:update` | Phase 5 end to end: pg_cron queues an update for a live case, the worker drafts it, the console shows it as a diff, and the public keeps the live version until the admin approves |
| `pnpm --filter @sia/admin e2e:live-update` | Phase 5 in the browser: a scheduled update lands in the queue as a diff; the live case is unchanged until it is approved |
| `PIPELINE_LIVE=1 pnpm --filter @sia/pipeline test test/fabricated-claim.test.ts` | The real fact-checker against planted claims (about $0.40) |

Run the database suites one package at a time; they share one local database.

## Deploying

The concrete steps for the owner's Supabase and Expo projects are in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

1. **Supabase.** Create a project, enable the `pg_cron` and `pg_jsonschema`
   extensions, then `npx supabase link` and `npx supabase db push`. In Auth
   settings, turn off new signups (email and password sign-in stays on). Create
   the owner and pipeline accounts with `staff:create` against the project.
   The client IP for rate limits comes from `cf-connecting-ip` by default
   (`app.settings` key `ip.source`).
2. **Admin console.** Deploy `apps/admin` (for example to Vercel) with
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
   `NEXT_PUBLIC_DIVE_APP_URL`. It refuses to start with a service-role key.
3. **Pipeline worker.** Run `services/pipeline` as a long-lived process or
   container with the pipeline account's credentials and Claude access. pg_cron
   queues re-research jobs for live cases on the cadence set in the console.
4. **Dive app.** Build with EAS, setting `EXPO_PUBLIC_SUPABASE_URL`,
   `EXPO_PUBLIC_SUPABASE_ANON_KEY` and `EXPO_PUBLIC_SHARE_BASE_URL` (the https
   origin of the web build, so share links open without the app). Host the web
   export with a fallback to `index.html` so `/case/<slug>` links resolve.

## Status against the spec

| Phase | Done when | Proof |
| --- | --- | --- |
| 1. Schema and database | The validator rejects an uncited step; the public cannot read a draft | `case-schema` and `supabase` tests |
| 2. Dive player | Two different case files play with no code change; crowd hidden until commit | `mobile` jest and `e2e:web` |
| 3. Admin console | Edit then approve creates a new immutable version; old responses stay with the old version | `admin` e2e |
| 4. Agent pipeline | A one-line brief produces a schema-valid package with sources actually opened; a planted fabricated claim fails | `pipeline` tests, live fabricated-claim test, [`docs/acceptance/phase4-clancy`](docs/acceptance/phase4-clancy) |
| 5. Live updates | A revision appears in the queue as a diff; the live case is unchanged until approved | `pipeline` update tests and `e2e:update` |

**Before v1 ships:**

- The owner reviews the Cornell package in the console. Its 16 open issues
  include the decisions only the owner can make: the combined question, and
  whether source links that name accused students appear on the transparency
  page.
- Play the app end to end on real iOS and Android devices. Native sharing,
  secure storage and screen-reader focus were built and tested in renderers
  and on the web, not on devices.
- The open spec decisions use the defaults: Cornell as the first seed case and
  the personal shift as the primary share card.
