# Social Issues App — Build Spec v1

Oct 7, 2026 · @Nick

## Overview

The app is a case-agnostic engine. Adding a new controversy means running an agent pipeline and approving its output in an admin queue, never writing new app code.

When a controversy erupts, the app is the one calm place where it is already laid out properly. A user records a gut position, walks through the facts one at a time, answers a micro-poll after each fact, and sees how their certainty moved compared with everyone else.

The product has three parts:

1. **Dive app.** The consumer app that plays any published case.
2. **Agent pipeline.** It researches a case, drafts the dive, attacks its own draft, and submits a package for review.
3. **Admin console.** The owner reviews each package and accepts, edits, or rejects it. Nothing reaches users without approval.

**v1 proves:** a single published dive is good enough that people finish it and share their result. It also proves the pipeline can produce a second case with no code changes.

**Decisions locked**

- Every user sees the identical dive: same facts, same order, same questions. Personalization comes only from reflecting the user's own earlier answers back to them.
- There is a micro-poll after every key fact. The crowd result stays hidden until the user commits an answer.
- Evidence is layered. A clean spine shows at the top, and the user can tap any fact to go deeper.
- v1 has no login. Crowd numbers are seeded and clearly flagged as seeded in the data model.
- Visual direction is editorial and calm. Color and motion are reserved for the reveal.
- The admin is a human gate. Agents draft, and only the owner publishes.

**Decisions open**

- [ ] First seed case: Cornell (default in this spec) or Lindsay Clancy
- [ ] Primary share card: the user's own certainty shift (default) or the crowd distribution

## Architecture

Everything about a case lives in the database as versioned data. The app renders whatever published case version it receives, and the pipeline writes only draft versions.

| Component | Responsibility | Can write |
| --- | --- | --- |
| Dive app (React Native / Expo) | Plays any published case. Records poll answers and renders reveals and share cards. | Responses only |
| API (Supabase: Postgres, auth, edge functions) | Serves published case versions and aggregates crowd stats. Enforces that only `published` versions are visible. | Responses, aggregates |
| Agent pipeline (Claude Agent SDK, Node worker) | Takes a case brief, then researches, drafts, red-teams, and fact-checks it. Outputs a case package. | Draft case versions, research logs |
| Admin console (Next.js web app, owner login) | Review queue, side-by-side diff, inline edits, accept / reject / request revision, publish, schedule updates | Case status, edits, publish |

**Rules the code must enforce**

- The app has zero case-specific code. No case names, facts, or copy appear in the source tree. Seed cases load through the same import path as pipeline output.
- Every user-facing string in a dive comes from the case record.
- A published version is immutable. Edits create a new version, and responses stay tied to the version a user saw. This keeps the crowd data honest when facts change.
- The pipeline cannot set `status = published`. Only an admin action can, and the database checks this with row-level security.

## Case data model

A case is one JSON document that is validated against a schema. The pipeline emits it, the admin edits it, and the app plays it. Use the Zod schema below as the single source of truth, shared by all three components.

```typescript
Case {
  id, slug, title,
  status: 'draft' | 'in_review' | 'changes_requested' | 'rejected' | 'published' | 'archived',
  version: number,            // immutable once published
  parent_version?: number,    // what this revision updates
  as_of: date,                // facts current as of
  content_warning?: string,   // e.g. child deaths; shown before start
  question: {                 // the ONE position everyone is measured on
    prompt,                   // "How responsible is X for Y?"
    scale: { type: 'slider', min: 0, max: 100, left_label, right_label }
  },
  starting_facts: Fact[],     // the agreed, no-spin baseline shown first
  steps: Step[],              // ordered; identical for every user
  sides: { id, label, steelman }[], // strongest case for each side, in its own words
  open_questions: string[],   // what is still unknown, shown at the end
  sources: Source[],
  review: ReviewRecord         // agent reports + admin decisions
}

Step {
  id, order,
  headline,                   // one-line fact for the spine
  body,                       // 2-4 sentences
  depth: Layer[],             // tap-to-go-deeper: documents, quotes, timeline, context
  favors?: side_id | 'neutral', // admin-visible only; used for balance checks
  source_ids: string[],       // every claim must cite at least one
  confidence: 'established' | 'reported' | 'disputed' | 'alleged',
  micro_poll: { prompt: 'Does this change your position?', re_ask_slider: true }
}

Source { id, title, publisher, url, date, type: 'court_record'|'official'|'primary'|'news'|'analysis', accessed_at, quote_excerpt? }

Response { session_id, case_id, case_version, step_id | 'before' | 'after', value: 0-100, created_at }
```

**Rules**

- Every `Step` needs at least one source. Any step with only a `news` or `analysis` source is labeled `reported`, not `established`.
- `favors` never reaches the client. The admin console uses it to show the balance of the fact order.
- `Response` stores a `session_id`, not a user ID. When accounts and verification arrive later, sessions get linked to a verified person, and no schema rewrite is needed.

## Agent research pipeline

A new case starts from a one-line brief from the admin, such as "Lindsay Clancy trial verdict." It ends as a case package in the review queue. Each agent has one job, and the critic agents exist to break the drafter's work before the admin sees it.

[embedded content: case pipeline · 7 agents, 1 human gate]

The critics loop back to research until they find nothing blocking. Only your approval moves a case to Published.

| Agent | Job | Output |
| --- | --- | --- |
| 1. Scoper | Defines the single measurable question and the sides. Writes the list of things the dive must answer. Flags whether a content warning is needed. | Case outline, question, side list |
| 2. Researchers (one per side, plus one primary-records agent) | Each side's researcher builds the strongest honest case for that side. The records agent pulls court filings, official statements, and timelines. All of them must log every source they open. | Research log per side, source list |
| 3. Drafter | Builds `starting_facts`, the ordered `steps`, depth layers, and side steelmen from the research only. It adds no outside claims. | Draft case JSON |
| 4. Hard-questions agent | Asks what a sharp skeptic on each side would ask. It finds what the draft avoids, what is missing, and which fact would move people most if true. Unanswered questions go back to the researchers. | Question list, gap list |
| 5. Red team (one per side) | Reads the draft as a partisan from each side. It flags cherry-picking, loaded wording, order effects, and missing exculpatory or damning facts. | Bias report per side |
| 6. Fact-checker | Re-opens every cited source and confirms the claim says what the step says. It downgrades `confidence` where needed and fails any uncited claim. | Claim-by-claim verification table |
| 7. Editor | Applies fixes, enforces house style (plain words, no adjectives that judge), and runs schema validation. | Final case package |

**Loop rules**

- Steps 4 to 6 loop back to the researchers and the drafter until the hard-questions agent has no blocking gaps. Each red team must report no unaddressed high-severity flags. The loop stops at 3 rounds, and anything still unresolved goes to the admin as an open issue.
- Run each red team with a fresh context that has not seen the drafter's reasoning, so it is not grading its own work.
- Agents must fetch and read a source before citing it. A search snippet is not a source.
- Every agent writes to a `research_log` table, recording the queries run, pages opened, and claims extracted. The admin can audit how any fact got in.

**The package sent to review contains:** the case JSON, the research logs, the hard-questions list with how each was resolved, both bias reports, the fact-check table, a balance summary (count of steps favoring each side and their order), and a list of open issues.

**Updates to a live case.** A scheduled job re-runs the researchers against a published case on a cadence the admin sets, daily while a story is hot. New developments produce a revision package against the current version, which goes through the same review. The live case never changes without approval.

## Admin review and approval

The admin console is where the owner decides. Each package opens to a single review screen, and nothing publishes without an explicit approve action.

**Review screen layout**

1. **Header.** Case title, version, as-of date, and open-issue count.
2. **Preview.** The dive exactly as a user will see it, playable in a phone-sized frame.
3. **Step list.** Each step shows its sources, confidence, `favors` tag, and any fact-checker or red-team flags on it. Every field is editable inline.
4. **Balance panel.** Steps per side and where in the order each side's strongest facts fall. It warns when one side's best facts are bunched at the end.
5. **Audit tabs.** Research logs, hard questions and their resolutions, bias reports, and the fact-check table.
6. **Diff view.** For revisions, a side-by-side comparison against the live version.

**Actions**

| Action | Effect |
| --- | --- |
| Approve and publish | Creates an immutable published version and makes it live. |
| Approve and schedule | Same as above, but goes live at a set time. |
| Request changes | Sends written notes back to the pipeline, which runs a revision round using them as instructions. |
| Edit then approve | Admin edits are saved as a new draft version tagged `admin_edit` and then published. |
| Reject | Archives the package and stores the reason. |

**Rules**

- Admin notes and every decision are stored in `ReviewRecord`, with timestamps, so the history of each case is auditable.
- Publishing is blocked while any step has zero sources or any schema error exists.
- v1 has one admin account, the owner. Roles can be added later.

## User-facing dive flow

A dive is a fixed sequence of screens generated from the case record. The flow is the same for every case.

1. **Case card.** Title, as-of date, estimated time, and the content warning if there is one.
2. **Starting facts.** The agreed baseline with no spin, one screen.
3. **Before.** The question and a 0 to 100 slider. The user's answer is locked and cannot be changed later.
4. **Step screens, one per step.** The headline and body, with "Go deeper" to expand the depth layers. Then the micro-poll: does this change your position? The user re-sets the slider, pre-filled at their last value. After they commit, the reveal shows two things:
   - **Personal mirror:** "You moved from 90 to 75" or "This didn't move you."
   - **Crowd:** how everyone who reached this step moved, shown as a small shift chart.
5. **Flag this fact.** A link on every step lets the user mark a fact as unfair or cherry-picked, with an optional note. Flags go to the admin console.
6. **After.** The same question and slider as the Before screen.
7. **Final reveal.** The user's before-to-after line over the crowd's before and after distributions. Also shown: the step that moved the user most, the step that moved the crowd most, and the open questions.
8. **Share card.** The default is the personal shift card, such as "I started at 95. I ended at 70. Find where you break." It includes a small crowd distribution and a deep link into this case.

**Design rules:** editorial and calm, with serif headlines, heavy whitespace, and near-monochrome screens. Accent color and motion appear only in reveals. The crowd result is never visible before the user commits on that step.

## Crowd data, seeding, and trust guardrails

The crowd numbers are the product, so the data model has to keep real responses and seeded responses separate from the start.

- **Seeding.** Each case can carry a `seed_profile` written by the admin: a before distribution plus a per-step shift. Seeded rows are stored with `is_seed = true`. Every aggregate query takes an `include_seed` flag. Seeds fade out automatically once a case passes a threshold the admin sets, such as 500 real completions.
- **Version integrity.** Aggregates are computed per `case_version`. When a revision publishes, the reveal shows that version's crowd and notes, for example: "Updated Oct 12; 3,104 people saw the earlier version."
- **Abuse floor without login.** Use one session per device, rate limits per IP, and drop responses that finish faster than a reading-time floor. This holds until the verified-human system ships.
- **Fairness signals.** User flags on facts, plus an optional end-of-dive question: "Was this fair to your side?" Both are shown per side in the admin console. A case where one side rates it unfair goes back into review.
- **Transparency page per case.** Lists the sources, the as-of date, and the version history, with a plain line explaining how the dive was researched and approved.
- **Later, not v1:** verified-human accounts (one phone number and email pair per person), the argue-after section, multiple live cases, and Instagram share deep links.

## Tech stack, build order, and acceptance criteria

Build it as one monorepo with the case schema shared across all three parts. Work in the phases below, and do not start a phase until the previous phase's checks pass.

**Stack:** TypeScript everywhere · pnpm monorepo · Expo (React Native) app · Next.js admin · Supabase (Postgres with row-level security, edge functions, scheduled jobs) · Claude Agent SDK for the pipeline, with web search and fetch tools · Zod for the case schema.

```
/packages/case-schema   Zod schema + types + validator (single source of truth)
/apps/mobile            Expo dive player
/apps/admin             Next.js review console
/services/pipeline      agent orchestrator + agent prompts (one file per agent)
/supabase               migrations, RLS policies, seed import script
/cases/seed             hand-checked seed case JSON (Cornell)
```

**Build phases**

1. **Schema and database.** Case schema, migrations, row-level security (only `published` is readable by the public, and only the admin can publish), and the response and aggregate tables.
   - Done when the validator rejects a case with an uncited step, and the public client cannot read a draft.
2. **Dive player.** Renders any case JSON through the full flow, with seeded crowd data and the share card image.
   - Done when two different case files play correctly with no code change, and the crowd result is hidden until commit.
3. **Admin console.** Queue, preview, inline edit, balance panel, audit tabs, actions, and version diff.
   - Done when an edit-then-approve creates a new immutable version and old responses stay attached to the old version.
4. **Agent pipeline.** Agents 1 to 7, the loop rules, research logs, and the package writer.
   - Done when a one-line brief produces a schema-valid package with sources that were actually opened. Run a test that plants a fabricated claim in the draft, and confirm the fact-checker fails it.
5. **Live updates.** A scheduled job that produces revision packages against a live case.
   - Done when a revision appears in the queue as a diff, and the live case is unchanged until it is approved.

**v1 ships when** the Cornell case passes admin review and plays end to end on iOS and Android. A second case, Clancy, must also go from a brief to the review queue with no code changes.

**Agent prompt standards (put these in each agent's system prompt)**

- Use only facts from sources you opened in this run, and cite each one.
- Mark anything disputed or alleged as such, and never present one side's claim as fact.
- Use no judging adjectives in user-facing copy, such as "shocking," "clearly," or "brutal."
- For cases involving minors or victims, use no names of private individuals beyond what court records and major outlets already publish.
