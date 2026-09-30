# Powerplay default Analytics dashboard — implementation plan

## Context

Customers keep asking for the same things, and today each gets a one-off dashboard. The recurring asks come from Adarsh, Continuum, Dhinwa, HNB, Kasturi, Svastiga and others:
- who updated and who didn't;
- planned vs actual;
- delayed, ongoing and upcoming tasks per site and per person;
- a one-page management PDF;
- procurement status.

The dashboards built so far each run as Python → single HTML file per org, and they took weeks each. HNB and Kasturi say the missing "who is updating" visibility is costing renewals. The mobile analytics dashboard was "not in roadmap" (PSTD-4904).

**Goal:** one default dashboard that works for any org. It should be clean and insight-first, work on mobile, and serve leadership, the Projects team (PMs) and Procurement. The centrepiece is an **updation health** report: "20 of 100 scheduled tasks updated · 20%", per site, per person, per day, with who to follow up with.

## Decisions (from you)

| Topic | Decision |
|---|---|
| "Scheduled for a day" | Plan window (planned start ≤ D ≤ planned end, not already complete). A toggle adds overdue open tasks. |
| Data freshness | The **live Kafka tables** in `pp_ic_bi_product_analytics_cdc`. Modules without a Kafka table use the T-1 batch DB, with a label. |
| Scope | Every module that has data in ClickHouse today. A module lights up automatically when its pipeline lands. |
| Access | Data protection first. Accounts are created by an admin. A user can **never** see an org they don't belong to or haven't been granted. Inside an org, the app's permissions are mirrored. |
| Deployment | Runs locally on the VPN now, built so it can be hosted later without redesign. |

**On "can you fetch the app permissions?"** Yes. Three membership tables are synced live into ClickHouse CDC, and Retool already reads them:
- `usertoorgs`: org membership and role;
- `usersprojects`: project membership;
- `teams`: designations such as Organization Management Team, Project Manager, Project On-site Team.

A read-only probe (M0) confirms the exact columns. If any of them is missing or unreadable, the dashboard **fails closed**: no access.

## What the research established

- **ClickHouse "118"** is the production host `172.31.64.118:8123`, user `readonly`, reachable only on the office network or VPN.
  - Kafka-suffixed tables in `pp_ic_bi_product_analytics_cdc` are ReplacingMergeTree. Every read must deduplicate with `ROW_NUMBER() OVER (PARTITION BY id ORDER BY updatedAtMS DESC) = 1`, with org and project filters *inside* each base query. Never use `FINAL`.
  - Batch DB `pp_ic_bi_product_analytics` is refreshed daily at 06:00–06:35 IST. Its tables are Mongo-flattened, so group by `_id`.
- **Proven formulas** from the Adarsh and Continuum repos (cloned read-only for reference):
  - Actual % = Σ(duration × pct) / Σ duration. This equals `project_progress`.
  - Planned % is time-linear per leaf task, with inclusive dates.
  - Days behind uses earned schedule, with bands On track ≤30, Behind 31–90, Critical >90.
- **Data traps to handle:**
  - `tasklog.date` is IST midnight stored as 18:30 UTC, so convert with `toDate(toTimeZone(…, 'Asia/Kolkata'))`.
  - Some logs are dated in the future.
  - Any % complete above 100 is a **data bug**, never valid data. DIB-3555 showed 140% in the Gantt. Such a row is listed in the **Data checks** panel (task, site, value) and is not silently used. It counts as complete for status and is capped at 100 for the weighted average, with that fix shown next to the check.
  - `1970-01-01` means no date.
  - The leaf flag is `type = 0`; `leaf_task` is a name, not a flag.
  - PO revisions reuse `po_display_id`; Dhinwa double-counted ₹1.28 Cr this way.
  - CDC and Mongo status can disagree. Dhinwa had a PO that was PARTIALLY_DELIVERED in ClickHouse but DELIVERED in Mongo.
  - Assignee names arrive comma-joined, so prefer `usertotasks` joined to `users._id`.
  - The column recording who made a task-log entry is unconfirmed; the probe resolves it.
- **Common asks across customers:**
  - daily "who updated / who didn't";
  - star performers vs laggards;
  - user-wise and project-wise delayed / ongoing / upcoming;
  - portfolio view of "where am I slipping";
  - pending approvals and their age;
  - one-page PDF; CSV/Excel export;
  - consistency with in-app numbers;
  - speed;
  - mobile.

  One CEO observation: "The real user is middle management."

**Roadmap sheet ("Product roadmap 2026", all tabs):** a reader is still going through it. Its "Persona to business" jobs-to-be-done (for example, Purchase manager → "Tracking procurement to prevent delay (PO, GRN, INDENT)"; Site team → "Tracking delay") and the 2026 themes (notification centre, smart approvals, flow completion, procurement funnel) will be mapped onto each view's contents and the insight rules before M2. Nothing in the architecture depends on it.

## Architecture

```
ClickHouse (Kafka live tables → batch fallback)
   │  server/ : read-only guard · schema/module registry · org-scoped query builder · per-org cache
   ▼
Dataset (normalised rows, shared/types.ts)
   │  shared/metrics/ : pure TS engine (docs/METRICS.md), unit-tested
   ▼
View models → React app (src/) : hash-routed, URL holds every filter, mobile-first
```

### 1. Data layer (`server/`)

- **`clickhouse.ts`**
  - Sends queries over HTTP (POST SQL, `FORMAT JSONEachRow`).
  - All IDs go in as **server-side parameters** (`{org:String}`, `{projects:Array(String)}`), never pasted into SQL.
  - Guard: accepts only single SELECT/WITH/DESCRIBE/SHOW statements, only against the two allowed databases.
  - Handles timeouts and errors that arrive mid-stream.
- **`registry.ts`: a module registry.** Each module declares logical fields → candidate columns, plus a live table and a batch table:

  | Module | Needed for | Tables |
  |---|---|---|
  | Tasks & updates | Updation, Sites, Team, Activity | tasks, tasklogs, users, usertotasks |
  | Access | Access control | usertoorgs, usersprojects, teams |
  | Issues | Issues | threads |
  | Procurement | Procurement | indents, purchaseorders, grns, payables |
  | Labour | Labour | attendance, workerlists / orglabours |
  | Materials | Materials | inventories, materialissues |
  | Work orders | Work orders | workorders |

  At startup it runs `SHOW TABLES` and `DESCRIBE` and picks live over batch per module. Modules that can't be resolved are hidden. The resolved map, including each module's freshness, shows in `/api/health`.
- **Per-table base queries** apply, in this order:
  1. dedup (live tables) or group-by-`_id` (batch);
  2. `org_id = {org}` inside the base;
  3. `is_active` / deleted filters.
- **`repository.ts`** builds a Dataset per org:
  - active projects;
  - leaf tasks;
  - task logs for the window (at most 150 days);
  - per-task history computed in SQL: % at window start, first-100% date, first-started date;
  - watermark, issues, POs (deduplicated by display ID), people.

  Future-dated logs are excluded and counted as warnings.
- **`cache.ts`**
  - Keeps a Dataset per org and reloads only when a cheap freshness check changes: `max(updatedAtMS)` for live tables, `max(updated_at)` for batch.
  - Concurrent loads of the same org are merged into one.
  - If a reload fails or drops sharply (more than 20% fewer rows, or duplicate `_id`s), it keeps serving the last good copy with a banner.
  - It saves that copy to disk in the git-ignored `data/cache/`.

### 2. Security and access (`server/auth/`), which fails closed everywhere

- **Accounts**
  - Admin-provisioned through a CLI: `npm run user:add|grant|revoke|disable|list`.
  - Stored in git-ignored `data/accounts.json`. Passwords are hashed with scrypt from `node:crypto`.
  - Each account links to a Powerplay user ID (`USR…`) and lists the org IDs an admin granted.
- **Effective access** applies the same rule to every account, internal staff included. There is no override. It is recomputed on each dataset refresh and cached per session:
  - **Orgs:** admin grants ∩ live `usertoorgs` membership. A grant for an org where the user isn't an active member gives nothing.
  - **Projects:** all projects in the org if the user's `usertoorgs` role or `teams` designation is org management; otherwise only their `usersprojects` memberships.
- **Enforcement**
  - The org is **never trusted from the client**. A request for an org the session doesn't have returns 404, so org IDs can't be enumerated.
  - Project filters are intersected with the allowed projects on the server.
  - Cache and response keys include the org and the scope.
  - Every result row's `org_id` is checked before use.
  - People and names come only from the scoped org.
- **Sessions**
  - HttpOnly, SameSite=Strict signed cookie; Secure when hosted.
  - Idle timeout 8 h, absolute 7 d.
  - Login rate limit and lockout.
  - Append-only `data/audit.log`: logins, org views, exports. Data rows are never logged.
- **Hardening**
  - Binds to `127.0.0.1` by default.
  - Strict CSP; fonts self-hosted, no third-party requests.
  - Secrets only in `.env`, which is git-ignored.
  - Hosting later needs only TLS termination and `COOKIE_SECURE=1`.
- **Reminders** are a prefilled WhatsApp or copy text that the PM sends themselves. No phone numbers are ever exposed.

### 3. Metrics engine (`shared/metrics/`)

This implements `docs/METRICS.md`, which already exists in draft, updated as follows.

- **Scheduled on D**
  - Planned start ≤ D ≤ planned end, and not complete before D. Completion comes from the actual end date or the first log at 100%.
  - Also counts tasks that actually started before their planned start.
  - Toggle for overdue open tasks: *off* (default) · *started only* · *all*.
- **Updated on D:** at least one log dated D. Back-filled entries count, but are flagged.
- **Health**
  - Day health = updated / scheduled.
  - Window health = sum of task-days.
  - Bands: Good ≥80 · Fair ≥50 · Poor ≥25 · Critical <25 (configurable).
  - Also shows a secondary "updated in last 7 days" figure, so tasks reported weekly aren't punished.
  - The last 2 days are marked provisional.
- **Sites and people**
  - A site is silent after 3 working days without an update.
  - People are shown through two lenses. **Updaters** covers entries made, active days and back-filled share. **Owners** covers assigned tasks still pending.
  - People statuses: Active / Irregular / Silent / Never logged.
  - Scheduled tasks with no owner are flagged.
- **Progress**
  - Actual and planned as above; days behind with its bands; slip over 4 weeks.
  - Status buckets as of D: completed / overdue / ongoing / late start / upcoming / later / undated.
- **Procurement:** PO stages, pending-approval age, open deliveries, and indent → PO → GRN once those tables resolve.
- **Insights:** rule-based sentences, ranked, at most 8, each linking to where you can act.
- **Performance:** everything is linear in tasks + logs + days (difference arrays, indexes built once), with a budget of ≤300 ms for 30k tasks and 300k logs.

### 4. Site photos (if the database has them)

Photos are the most trusted evidence of progress, and Dream House asked for photo proof of updates.

- **Where they might be.** Task logs carry `proof_files` / `photos_details` in Mongo. DER-111 added an attachment-count column to the batch task table. The M0 probe checks whether ClickHouse holds photo **URLs or keys**, or only counts.
- **If URLs or keys exist:**
  - A **Site photos** strip in the site sheet: latest first, with task, person and date.
  - Thumbnails in the activity feed.
  - A tap-to-zoom lightbox, swipeable on mobile.
  - "Photo updates" becomes an evidence signal in Team: the share of updates that carry proof.
- **Security.** Photos are customer data. The browser **never gets raw bucket URLs**. Images go through `/api/photo/:logId/:n`, which checks that the log belongs to the session's allowed org and project, then streams the image or redirects to a short-lived signed URL. Responses are `private, no-store`.
- **If only counts exist:** show a photo-count badge per entry and the evidence share. The strip turns on automatically once URLs land in ClickHouse, through the module registry.

### 5. Design direction: "a calm instrument"

The aim is a dashboard that feels crafted, not assembled. Every screen answers one question at a glance and rewards a closer look. Powerplay's design system is the base so it feels like home: brand blues, navy ink, Clash Grotesk and IBM Plex, the gradient tiles. I'll depart from it wherever the experience needs it.

- **Composition.**
  - An editorial layout on a soft paper-white canvas.
  - One deep-navy **hero band** per view. It uses the brand's `#00133E→#05287A` gradient and holds the headline sentence and number.
  - White cards with hairline borders and generous whitespace underneath.
  - One focal point per screen.
- **Typography.**
  - Clash Grotesk for display numbers and headings, which carry the brand voice. The hero figure is large and quiet.
  - IBM Plex Sans for interface text; tabular figures in tables.
  - Sentence-case, plain-language copy: "Orchid Heights hasn't updated in 6 working days."
- **Signature piece: the "updation calendar".** Sites × days drawn as a grid of rounded tiles, each printed with its %, coloured by band and marked with an icon on hover or focus. It is the one image that tells a PM who is keeping up. The same visual language repeats in small form: a 14-day strip per site and a ring meter in the hero.
- **Charts.** Hand-built SVG following the dataviz method:
  - thin marks, recessive axes, direct labels, a crosshair or tooltip on every mark;
  - a table view for every chart;
  - colour from the palette validator, with status colours reserved for state and always paired with an icon and label.
- **Motion.** 150–250 ms ease-out. Numbers count up on first load only. Sheets slide in. Refetches keep the previous render dimmed rather than showing skeletons. `prefers-reduced-motion` is respected.
- **Interaction.**
  - Swipe the day stepper on mobile; ← → keys on desktop.
  - `/` opens search; `g o / g u / g s / g t` jump between views.
  - Tapping any number opens the list behind it.
  - Every insight goes straight to the action: Remind, open the site, open the person.
- **Dark mode** is designed separately: its own tones and a validated palette, not an inversion.
- **States** are designed too: first-load skeleton, empty ("Nothing was scheduled on Sunday 28 Sep"), stale banner, and partial-module notices.
- **Quality bar.** During build I use the frontend-design and dataviz skills. After each view, I screenshot it at 390, 768 and 1280 px in light and dark, and critique and refine before moving on. Final pass: an axe accessibility check, AA contrast, visible focus rings, 44 px tap targets.

### 6. App (`src/`): Powerplay brand, light and dark

**Brand:** colours `#1946BB` and navy `#05287A` plus the status tokens; IBM Plex Sans and Clash Grotesk; the Powerplay logo. Charts are hand-built SVG following the dataviz skill: thin marks, a table view for every chart, the palette checked with its validator script.

**Header, on every view:** org switcher (only orgs you're allowed), site filter, day stepper (◀ date ▶), window (7/14/30/60/90 days), and a "Live · 2 min ago" or "Daily · as of 06:32" badge for each module.

**Views** (the bottom nav on mobile shows at most 5; everything else sits under More):

1. **Overview** (leadership).
   - Hero: "Yesterday 1,240 of 2,000 scheduled tasks updated · 62% ▼8 pp".
   - Up to 5 tappable insights.
   - Tiles: sites reporting, silent sites, actual vs planned, days behind, overdue tasks, pending PO approvals.
   - A worst-first site list with progress bullets.
   - A sites × days updation heatmap.
   - Sections can be hidden or reordered, and the choice is remembered per user.
2. **Updates** (PMs' daily loop).
   - "X of Y updated", and daily columns you can tap to change the day.
   - Heatmap.
   - Site list sorted by most pending.
   - **Site sheet:** pending tasks grouped by owner, each group with a **Remind** button (WhatsApp or copy); then updated tasks, overdue tasks, the next 7 days, and recent activity.
3. **Sites.** Planned vs actual, days-behind band, 4-week slip, status buckets, open issues. Tapping a site opens its sheet.
4. **Team.** Updaters and Owners lenses (laggards first, with a star-performers toggle), plus an Activity feed with filters: back-filled, notes, no-progress entries, photos. Tapping a person opens their sheet.
5. **Procurement.** Stages by count and ₹, approvals oldest-first with age chips, open deliveries, by site.
6. **More:** Issues, Labour, Materials, Work orders. Each appears only if its module resolved.
7. **Data checks** (under More, with a badge when something is found):
   - % complete above 100;
   - future-dated logs;
   - tasks without dates;
   - scheduled tasks with no owner;
   - duplicate PO revisions;
   - modules still on T-1 data.

   Each check lists its rows, so customer success can get the data fixed at source.

**Settings sheet:** working days, overdue toggle, bands, silent threshold, theme, and plain-language definitions ("How is this calculated?").

**Export:** CSV on every table; a print-to-PDF A4 one-pager of Overview.

**Mobile (390 px):**
- cards instead of tables;
- sheets open full screen and are tied to the URL, so Back closes them;
- the heatmap has a sticky site column and swipes sideways;
- tap targets ≥44 px;
- no sideways page scroll;
- when the network drops, the last view stays on screen, labelled stale.

**Flexibility:**
- Every state lives in the URL, so views can be shared as links.
- `?view=` sets the landing view per role.
- Thresholds are configurable.
- Modules are driven by the registry.

**Demo mode:** a deterministic generator with 3 synthetic orgs covering every state (critical site, silent site, back-filler, never-logger, sites behind plan, pending POs, aged issues). It runs without VPN and is used for QA. It never mixes with real data, and it's enabled only by `DATA_SOURCE=demo`.

## Phased delivery

**How the work is split.** I have no network access to ClickHouse: no schema, no data. So in this session I build everything that doesn't need the VPN (M1–M4 on demo data), plus the live data layer written against the best-known columns and backed by runtime schema discovery. You then run it locally on VPN and resume there (M0 and the live parts of M3/M4). A handoff doc lists the exact steps.

- **M0 — Probe (written here; you run it locally on VPN, about 15 minutes).**
  - `npm run probe` (in `server/scripts/probe.ts`) writes `server/schema/snapshot.json` containing **column names, types and row counts only, no data**.
  - It covers: the Kafka table list and their columns; the batch fallbacks; the permission tables; which column records who made each task-log entry; whether the two leaf flags agree; the hour distribution of task and log dates; distinct task and PO statuses; and size statistics for the largest orgs.
  - It also checks which photo URL or key columns exist, and counts tasks with % complete above 100, so the bug can be reported.
  - The snapshot pins the registry mappings. Until it exists, the server resolves columns at runtime from candidate lists and reports every guess in `/api/health`.
- **M1 — Contract, engine, demo data (off VPN).**
  - Revise `shared/types.ts` and `docs/METRICS.md`.
  - Engine modules: `shared/metrics/{prepare,schedule,progress,status,people,sites,activity,insights,procurement,index}.ts`.
  - Demo generator: `shared/demo/{rng,generator,index}.ts`.
  - Vitest suite, including a benchmark.
- **M2 — Core app on demo data.**
  - `src/app` (router, URL state, theme), `src/components` (SVG charts, Card, Sheet, BottomNav, DayStepper, DataTable, pickers).
  - Views: Overview, Updates plus the Site sheet, Team and Activity plus the Person sheet.
  - CSV export and the print one-pager.
- **M3 — Server, access and live data. v1 ships here.**
  - `server/{env,clickhouse,registry,repository,cache,api,index}.ts`, `server/auth/{accounts,session,access,audit,cli}.ts`.
  - Endpoints: `/api/{login,logout,me,dashboard,site,person,health,refresh}`, with production serving the built app.
  - A fake ClickHouse for tests, and `npm run reconcile`.
- **M4 — Remaining modules.** Sites polish, Issues, Procurement (indent → PO → GRN), plus Labour, Materials and Work orders wherever the probe shows tables. Site photos through the authenticated proxy, Data checks, Settings sheet, role landing presets. The photo strip and the lightbox get built on demo photos here.
- **M5 — Hosting readiness.**
  - Dockerfile, TLS and reverse-proxy notes, security headers, backup of the account store.
  - A day-close ledger that freezes each completed day's score, so re-planning doesn't rewrite history.
- **Later.** A daily digest, and nudges through the platform's notification centre (matches the 2026 roadmap theme; to be confirmed with the roadmap sheet).

Commits land on `claude/sleepy-babbage-w1qtwd` after each milestone. The existing local contract commit is revised in M1.

**Handoff for local continuation (delivered with this session's work):**
- `docs/LOCAL_SETUP.md`: install; `.env` (`CH_HOST=172.31.64.118`, `CH_USER=readonly`, `CH_PASSWORD`, which is never committed); `npm run probe` → review the snapshot → `npm run user:add` → `npm start`; and how to switch between demo and live.
- `docs/DATA_SOURCE.md`: every table and column the server reads, Kafka vs batch per module, the dedup rule, and the guard.
- `docs/RECONCILIATION.md`: the checklist to fill in on VPN.
- `CLAUDE.md` at the repo root: architecture, conventions, the commands above, and "resume at M0 → M3 live wiring". Claude Code running locally picks the work up from there.
- `.gitignore` covers `.env`, `data/` (accounts, audit log, cache) and any probe output that isn't the schema snapshot.

## Verification

Unit tests, security tests, fake ClickHouse and Playwright can all run here. Reconciliation needs the VPN, so you run it locally.

- **Unit tests (vitest).** One hand-computed example per METRICS.md rule. Invariants: updated ≤ scheduled; buckets add up to the total; Σ sites = headline; the window equals the sum of its days. Also: IST dates, URL round-trips, insight triggers, dedup and PO revisions, epoch-0 dates, future-dated logs.
- **Security tests.** An authorization matrix: user A must not reach org B through any route, parameter, cache key, export or **photo proxy**, and project scope must hold within an org. Plus: the query guard (non-SELECT, multiple statements, other databases, injection attempts through IDs), fail-closed when the permission tables are missing, session expiry, lockout.
- **Fake ClickHouse.** A `node:http` server replaying responses recorded on VPN, with column names only and data anonymised. It injects timeouts, HTTP 500s, empty tables and duplicate IDs.
- **Playwright on demo data**, at 390×844 (touch) and 1280×800. It uses the preinstalled Chromium in `/opt/pw-browsers`.
  - Main flow: insight → site → pending by owner → Remind.
  - Tapping a column changes the day; the URL survives a reload; Back closes sheets.
  - No sideways scroll; dark mode; the one-pager prints as 1 page; an axe accessibility check.
- **Reconciliation on VPN** (`npm run reconcile`), recorded in `docs/RECONCILIATION.md`:
  - Actual % within 0.1 pp of `project_progress`.
  - Leaf-task counts match the app.
  - Planned % matches the Continuum board.
  - PO totals match the Dhinwa ledger.
  - Hand spot-checks of "X of Y updated" in the app: 3 sites × 3 days.
  - Load times, cold and warm.

  Then one PM field-tests it on a phone.
