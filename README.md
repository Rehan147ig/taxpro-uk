# TaxPro UK

**UK FRS 102 (Section 29) corporate tax provision operating system.**

> TypeScript · Hono.js · React 19 · TanStack Router · Turborepo · PostgreSQL 16 (RLS) · Redis 7 · BullMQ · Decimal.js · Playwright

![Tests](https://img.shields.io/badge/tests-496%20unit%20%2B%206%20e2e-2ea44f)
![UK Eval](https://img.shields.io/badge/UK%20eval-9%2F9%20PASS-2ea44f)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933)
![TypeScript](https://img.shields.io/badge/typescript-5.9-blue)

TaxPro turns accounting data and prior tax workpapers into controlled, reviewer-approved **UK FRS 102 (Section 29) corporate tax provisions** and filing-ready evidence — for accounting firms, SME finance teams and mid-market groups.

> **Positioning:** not autonomous tax filing, not generic AI chat, not a generic tax engine, not a CT600 form filler. **AI prepares and explains; deterministic rules calculate; qualified humans approve and lock.**

---

## Table of Contents

- [Core Invariant](#core-invariant)
- [UK Tax Workflow](#uk-tax-workflow)
- [Architecture](#architecture)
- [Monorepo & Turborepo](#monorepo--turborepo)
- [Deterministic Tax Engine](#deterministic-tax-engine)
- [AI Layer](#ai-layer)
- [Governance & Security](#governance--security)
- [Compliance Exports](#compliance-exports)
- [Benchmarks](#benchmarks)
- [Verification State](#verification-state)
- [Distribution & Deployment](#distribution--deployment)
- [CI/CD & Security Scanning](#cicd--security-scanning)
- [Observability & Rate Limiting](#observability--rate-limiting)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Documentation](#documentation)
- [Known Gaps](#known-gaps)
- [License](#license)

---

## Core Invariant

The product rests on one non-negotiable division of labor:

1. **AI prepares, never decides.** AI classifies accounts, proposes mappings, mines credits and drafts memos — every output is zod-validated, traced and reviewable. A failed AI call can never corrupt a provision.
2. **The deterministic tax engine is the single source of truth.** `@taxpro/tax-engine` (Decimal.js exact math) computes every official amount; the calculation path is independent of AI success.
3. **Humans approve official decisions.** Partner sign-off is mandatory before any final or locked output; segregation of duties prevents a partner from approving a run they created or prepared.
4. **Locked runs are immutable.** Any mutation after lock returns `409 Conflict`; corrections require a new run version (`parent_run_id` lineage).
5. **Every material action is auditable.** Append-only `provision_events` (DB-trigger enforced) records run creation, calculation, review resolutions, exports and approvals.
6. **Tenant data is isolated at the database layer.** Row-Level Security + `NOBYPASSRLS` runtime role; missing tenant context fails closed.

---

## UK Tax Workflow

| Phase | What happens | Where |
|---|---|---|
| **A — Intake** | Source documents uploaded (SHA-256, versioned, immutable originals); entities carry a UK FRS 102 jurisdiction (`UK_FRS102`, `UK_FRS102_S29`, `UK`). Unknown jurisdictions fail closed — never silently guessed. | `modules/documents`, `modules/periods`, `config/db` |
| **B — Mapping** | AI proposes account → tax classification mappings; **humans decide**. Approved decisions are written as new versioned `tax_mappings` rows; prior-year approved mappings return as carry-forward proposals for confirmation — never silent copies. | `agent/subagents/mapping-agent`, `modules/mapping/proposals.routes.ts` |
| **C — Calculation** | Workbench: idempotent trial-balance import → **gated run** (entity, jurisdiction, evidence, no pending mapping decisions, non-standard period resolved, approved UK rules) → deterministic calculation with provenance hashes (`inputDataHash`, `mappingVersionHash`) → review items (missing mappings, low-confidence AI mappings, missing depreciation metadata, fiscal-year straddle). No AI in the math. | `modules/workbench/*` |
| **D — Review & Approve** | Review-item lifecycle → finalize → submit for approval → partner approval → **lock** (immutable). Maker-checker enforced where tenant-configured. | `modules/review`, `modules/provision/provision.routes.ts` |
| **E — Handoff** | Locked runs get a filing-ready handoff (CT600 band-correct + iXBRL validated), a deterministic manifest (`sha256`), and a reproducible ZIP package. External filing events are **recorded, never submitted** — TaxPro does not file with HMRC. | `modules/handoff/*` |

---

## Architecture

```text
┌────────────────────────────────────────────────────────────────────┐
│                      Operator UI (apps/web)                        │
│   React 19 · TanStack Router · code-split pages · Playwright E2E   │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ HTTPS / JSON
┌──────────────────────────────▼─────────────────────────────────────┐
│                    API (apps/api — Hono.js)                        │
│  auth · import · mapping · provision · workbench · handoff · agent │
│  upload · billing · netsuite · xero · qbo · periods · documents    │
│  rules · review · demo · health                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │ Eve AI layer │  │ Subagents    │  │ Deterministic calculator  │ │
│  │ model client │  │ mapping      │  │ resolveJurisdiction →     │ │
│  │ trace store  │  │ audit-defense│  │ createEngine(UK_FRS102_S29)│ │
│  │ pattern store│  │ (fallbacks)  │  │ (single source of truth)  │ │
│  └──────────────┘  └──────────────┘  └───────────────────────────┘ │
│  BullMQ workers: agent pipeline · worker-entry (separate process)  │
└───────┬──────────────────────────────────┬─────────────────────────┘
        │                                  │
┌───────▼─────────┐              ┌─────────▼─────────┐
│  PostgreSQL 16  │              │      Redis 7      │
│  RLS + NOBYPASS │              │   BullMQ queues   │
│  append-only    │              └───────────────────┘
│  audit events   │
└─────────────────┘
```

---

## Monorepo & Turborepo

npm workspaces + Turborepo 2.x orchestration, with task-level caching, dependency-aware ordering and persistent dev servers.

```text
taxpro-uk/
├── turbo.json                 # task graph: build → lint/test/db/eval → dev/start
├── docker-compose.yml         # production-shaped local stack (pg, redis, api, worker, web)
├── apps/
│   ├── api/                   # @taxpro/api — Hono.js REST API + BullMQ workers
│   │   ├── src/agent/         # subagents (mapping, audit-defense), orchestrator, prompts
│   │   ├── src/eve/           # AI operating layer (model client, traces, patterns)
│   │   ├── src/modules/       # 19 business modules (see API surface)
│   │   ├── src/db/            # Drizzle schema, seed, migrations
│   │   ├── scripts/           # eval harnesses, integration flow, role bootstrap
│   │   └── Dockerfile         # API image (worker runs the same image)
│   └── web/                   # @taxpro/web — React 19 SPA
│       ├── src/routes/        # Dashboard … Workbench, Handoff, Export Package
│       ├── e2e/               # Playwright operator workflows
│       └── Dockerfile         # nginx-served static image
└── packages/
    ├── tax-engine/            # @taxpro/tax-engine — pure UK FRS 102 S29 engine (Decimal.js)
    └── tax-engine-enterprise/ # @taxpro/tax-engine-enterprise — UK enterprise extension layer
```

### Turborepo task graph

| Task | Workspaces | Cached | Notes |
|---|---|---|---|
| `build` | all | ✅ `dist/**` | depends on `^build` (engine → api) |
| `dev` | api, web | ❌ persistent | `dependsOn: ["^build"]` |
| `lint` | all | ✅ | `tsc --noEmit` per workspace |
| `test` | engine, enterprise, api | ✅ | depends on `build` |
| `db:migrate` / `db:seed` / `db:synthetic` | api | ✅ | depends on `build` |
| `eval:uk` | api | ✅ | UK FRS 102 benchmark harness |
| `start` / `preview` | api, web | ✅ | production entrypoints |

### API surface

| Module | Base path | Highlights |
|---|---|---|
| Health | `/api/health` | liveness (no auth) |
| Auth | `/api/auth` | register/login (generic failure messages), JWT 24h, rate-limited |
| Provision | `/api/provision` | entities, runs, review items, AI findings, results, exports, `/eve/ask` |
| Mapping | `/api/mapping` | versioned mappings, audited overrides |
| Import | `/api/import` | Companies House import, trial-balance validation |
| Agent | `/api/agent` | parse, map, pipeline (BullMQ jobs) |
| Upload | `/api/upload` | CSV/Excel trial-balance upload |
| Billing | `/api/billing` | usage events, per-provision pricing |
| Integrations | `/api/netsuite`, `/api/xero`, `/api/qbo` | OAuth connections, sync orchestrators (QBO defaults to `UK_FRS102` + GBP) |
| Periods | `/api/periods` | entity groups, accounting/tax periods (CTA 2010 s.10 validation; non-standard → review) |
| Documents | `/api/documents` | source-document artefact store (SHA-256, provenance, versioned) |
| Mapping proposals | `/api/mappings/proposals` | AI/rules/import/carry-forward propose; **humans decide**; carry-forward never applies silently |
| Rules | `/api/rules` | UK rule registry — proposals, partner/admin approval, supersede/rollback |
| Review items | `/api/review-items` | review lifecycle — status machine, evidence request, human-only waiver |
| Workbench | `/api/workbench` | setup → idempotent import → gated runs → recalc-as-new-version (lineage) → blockers |
| Handoff | `/api/workbench/runs` … | handoff view, filing-ready, external filing record, manifest, package |
| Demo | `/api/demo` | demo tenant data |
| Config | `/api/config/flags` | feature flags |

**RBAC roles:** `admin` > `partner` > `reviewer` > `preparer` > `auditor` > `client_readonly`. Mutations require `preparer`+; read-only roles may only export approved/locked results.

---

## Deterministic Tax Engine

`packages/tax-engine` — a pure TypeScript package (Decimal.js exact math, frozen rate tables):

- **UK FRS 102 Section 29**: current corporation tax with the marginal-relief regime — 19% small profits rate ≤ £50k, 25% main rate ≥ £250k, marginal relief between (CTA 2010 s.18D); deferred tax under FRS 102 Section 29; ETR reconciliation walk; rollforward; journal entries; book-tax difference computation (depreciation via placed-in-service dates).
- **Determinism guarantees**: identical inputs → identical outputs. Inputs are hashed (`inputDataHash`, `mappingVersionHash`) and every run stores the mapping snapshot, rules used, engine version and assumptions it was computed from.
- **Jurisdiction isolation**: `createEngine(jurisdiction)` is a factory; `resolveJurisdiction()` maps persisted strings (`UK_FRS102`, `UK_FRS102_S29`, `UK`) with **exact matching only** — a missing or unrecognized jurisdiction fails closed with an error instead of silently guessing a regime.
- **118 unit tests** covering current/deferred tax, marginal relief, ETR walk, rollforward, journal entries, depreciation metadata and engine-freeze guards.

`packages/tax-engine-enterprise` — the UK enterprise extension layer (35 tests), kept separate so the core engine stays dependency-free.

---

## AI Layer

TaxPro talks to **any OpenAI-compatible chat-completions endpoint directly** — no Vercel AI SDK, no hosting dependency.

- `apps/api/src/eve/` — the **Eve operating layer**: model client, trace store, pattern store, subagent runner, run runtime.
- `apps/api/src/config/ai.ts` — provider resolution (`openai | nvidia | interfaze | custom`).
- **Structured JSON output is validated with zod**; malformed model output fails loudly (`InvalidOutputError`) and never silently corrupts a provision.
- **Retries with backoff** on transient failures (429/5xx/network/timeout) and a per-attempt timeout (`EVE_MODEL_TIMEOUT_MS`, default 60s).
- **Trace lifecycle** for every AI run: `started → completed | failed | timeout | fallback_used`, with input hashes and output JSON persisted.
- **Fallback behavior**: if the agent fails, the run degrades to the deterministic calculation path and is marked `needs_review` with an exception summary.

| Provider | Base URL | Example model |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `z-ai/glm-5.2` |
| `interfaze` | `https://api.interfaze.ai/v1` (`INTERFAZE_ENDPOINT`) | `gpt-4o-mini` |
| `custom` | your own endpoint | your own model |

### Subagents

| Subagent | Input | Output | Fallback |
|---|---|---|---|
| **mapping-agent** | accounts + balances | proposed tax classification, book treatment, timing category, confidence, citation, explanation | zod rejection → run marked with fallback, never crashes |
| **audit-defense** | book income, ETR, differences | ETR walk memos with risk flags, quality score | self-fallback memo + explicit error text |

All subagent outputs are **structural-only**: the deterministic engine remains the source of truth for every amount.

---

## Governance & Security

1. **Dual-role PostgreSQL setup** (`apps/api/scripts/bootstrap-roles.sql`): `taxpro_migrations` (schema owner) vs `taxpro_app` (runtime, `NOBYPASSRLS`).
2. **Row-Level Security** on all tenant-owned tables: `USING (tenant_id = app_current_tenant_id())`, transaction-scoped `set_config` inside `withTenantContext`. Missing tenant context fails closed (no rows visible).
3. **Append-only audit trail** (`provision_events`): a DB trigger rejects `UPDATE`/`DELETE`; privileges revoked from the runtime role.
4. **Segregation of duties**: partner sign-off enforces `submittedByUserId !== user.userId` and `requestedByUserId !== user.userId`; optional maker-checker across approve/lock/handoff/filing.
5. **Locked runs** block modification with `409 Conflict` (app-level `FOR UPDATE` row locks).
6. **Runtime role guard**: API startup fails fast when `NODE_ENV=production` and `DATABASE_URL` resolves to a superuser-like role; `validateRuntimeRoleSecurity()` refuses to start in non-dev if the connected role bypasses RLS or owns tenant tables.
7. **Generic auth failures** — no user enumeration. **RBAC on mutations** — `client_readonly`/`auditor` get 403 on all write endpoints.
8. **Secrets hardening**: GCM decryption enforces a 16-byte auth tag; `TOKEN_ENCRYPTION_KEY` mandatory in production; default JWT secret and superuser `DATABASE_URL` refuse to start in prod.

---

## Compliance Exports

All exports are **structure generators — validation-ready, not filing-ready**. No HMRC/Companies House submission validator is integrated; no filing-ready claim is made. Every artifact carries a rules/structure conformance verdict at build time.

- **CT600** (2016+): band-correct box selection — small profits rate → Box 13, main rate → Box 12, marginal relief → Box 12 + 14, exactly one band populated. Validated against HMRC-derived rules: UTR/Companies House formats, ISO period rules (≤ 18 months), box identities (Box 15 = 12 + 13 − 14), band selection, rate alignment per fiscal year.
- **iXBRL**: instance + inline docs, `ukgaap-frs102-2023-01-01.xsd` taxonomy lock, context/unit resolution for every fact, `decimals="2"`, deterministic 2-dp rendering, Companies House identifier scheme.
- **CTO XML**: GovTalk-style corporation tax online submission wrapper.
- **MTD readiness**: `buildMtdReadinessReport` / `assertMtdEligible` — UTR, agent authority, MTD sign-up, software connection checklist; mock HMRC client tests.
- **R&D claim package**: RDEC scheme math, loss-making handling, headcount/PAYE inputs.
- **Locked-run ZIP package**: xlsx + audit CSV + review-items CSV + AI-traces CSV + approval-trail JSON + assumptions JSON + **manifest.json** (schemaVersion, generatedAt, period, source/mapping/engine provenance, per-file SHA-256, fileCount integrity) — **byte-deterministic** across wall-clock gaps (no wall-clock data; timestamps derive from the run's immutable `createdAt`).

---

## Benchmarks

Both harnesses are honest about what they validate. Methodology: `docs/UK_PRODUCT_ARCHITECTURE.md`, `docs/AI_EVAL.md`.

### UK FRS 102 — curated Companies House filings

`npm run eval:uk` — **9/9 PASS, mean ETR delta 1.3 bp, mean deferred closing delta 0.0 bp.**

| Company | CH Number | Period End | ETR delta | Deferred closing | Status |
|---|---|---|---|---|---|
| Greggs plc | 00502851 | 2024-12-28 | 5 bp | 0 bp | PASS |
| Greggs plc | 00502851 | 2025-12-27 | 3 bp | 0 bp | PASS |
| Finsbury Food Group Limited | 00204368 | 2025-06-28 | 1 bp | 0 bp | PASS |
| Tesco PLC | 00445790 | 2026-02-28 | 1 bp | 0 bp | PASS |
| Tesco PLC | 00445790 | 2025-02-22 | 1 bp | 0 bp | PASS |
| Costa Limited | 01270695 | 2024-12-31 | 1 bp | 0 bp | PASS |
| Vodafone Limited | 01471587 | 2025-03-31 | 0 bp | 0 bp | PASS |
| Farmfoods Limited | SC030186 | 2024-12-28 | 0 bp | 0 bp | PASS |
| Tiny Rebel Limited | 07582051 | 2023-12-31 | 0 bp | 0 bp | PASS |

The Tiny Rebel fixture is a genuine marginal-relief case: its ETR reconciliation includes an explicit "Tax at marginal rate" line, verified against the filed accounts.

### AI mapping eval (200-account golden set)

`npm run eval:ai-mapping -w @taxpro/api` — golden dataset at `packages/tax-engine/eval/golden-mapping.json` (12 permanent, 60 temporary, 128 no-difference accounts):

| Mode | When | Behavior |
|---|---|---|
| **dry-run** | no provider key | counts golden-set distribution, no model calls, exit 0 — no accuracy claim |
| **mocked** | `AI_EVAL_MODE=mocked` / `MOCK_AI=1` | deterministic in-process mock; verifies harness wiring |
| **real** | key configured + `AI_EVAL_MODE=real` | live provider; **≥ 80% accuracy threshold enforced** (exit 1 below) |

### AI subagent harness (16 fixtures)

`npm run harness -w @taxpro/api` — happy paths, multi-entity, UK (VAT standard, B2B zero), R&D/credit (present/absent/partial), adversarial (ambiguous names, empty ledger, extreme balances, near-threshold). Asserts **structure only** — zod validation, fallback behavior, graceful degradation — never tax math. Real mode: fallback-rate threshold `AGENT_HARNESS_FALLBACK_THRESHOLD` (default 25%).

---

## Verification State

| Gate | Command | Result |
|---|---|---|
| Lint / typecheck | `npm run lint` | PASS (5/5 workspaces) |
| Unit tests | `npm test` | **496/496 PASS** (engine 118 + enterprise 35 + API 343 across 30 files) |
| Build | `npm run build` | PASS (4/4 workspaces) |
| Operator E2E | `npm run test:e2e` | **6/6 PASS** (auth + operator workflow + workbench import→run→recalc→provenance + handoff lifecycle + tenant isolation) |
| UK eval | `npm run eval:uk` | 9/9 PASS, mean ETR delta 1.3 bp |
| AI mapping eval | `npm run eval:ai-mapping -w @taxpro/api` | dry-run/mocked/real modes |
| Agent harness | `npm run harness -w @taxpro/api` | 16/16 fixtures, structure-only, mocked |
| Provision integration | `npm run test:integration -w @taxpro/api` | provision lifecycle on live Postgres/Redis |
| CI | GitHub Actions on `master` | lint, tests, Docker build + Trivy, Semgrep, CodeQL, OSV green |

---

## Distribution & Deployment

### Container images

| Image | Source | Content |
|---|---|---|
| `taxpro-api` (also `worker`) | root `Dockerfile` / `apps/api/Dockerfile` | Node 22, compiled `apps/api/dist`; `RUN_WORKERS=true` switches entrypoint to `dist/worker-entry.js` (BullMQ worker process) |
| `taxpro-web` | `apps/web/Dockerfile` | nginx-served static SPA build |

### Docker Compose stack

`docker-compose.yml` runs the full production-shaped stack locally:

| Service | Image | Ports | Notes |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | 5432 | auto-bootstraps `taxpro_app`/`taxpro_migrations` roles on fresh volumes |
| `redis` | `redis:7-alpine` | 6379 | BullMQ queues |
| `api` | local build | 3001 | runs migrations + seed, `RUN_WORKERS=false` |
| `worker` | local build | — | `RUN_WORKERS=true`, separate BullMQ process |
| `web` | local build | 8080 | nginx SPA → API via `CORS_ORIGIN` |

Every service has a healthcheck; API/worker wait on Postgres + Redis health before starting.

### Image registry & deployment

`.github/workflows/deploy.yml` builds and pushes to **GitHub Container Registry** on `v*` tags (or manual `workflow_dispatch` with `staging` / `production`):

```
ghcr.io/<org>/taxpro-uk/api   (semver, short-sha, latest)
ghcr.io/<org>/taxpro-uk/web   (semver, short-sha, latest)
```

The deploy job is a documented placeholder — adapt the target (VM, k8s, PaaS) to your infrastructure; migration/seed are handled by the API container at boot (`RUN_MIGRATIONS` / `RUN_SEED`).

---

## CI/CD & Security Scanning

Every push/PR to `master` runs GitHub Actions workflows (`.github/workflows/`):

| Workflow | What it runs |
|---|---|
| `ci.yml` | **Security Scan** (Gitleaks advisory + TruffleHog verified secrets) · **Lint & Test** (fresh Postgres 16 + Redis 7: bootstrap roles → migrate → seed → `npm test` → build → AI mapping eval dry-run → agent harness mocked) · **Docker Build & Scan** (API + Web images, Trivy HIGH/CRITICAL, SARIF uploaded) |
| `codeql.yml` | GitHub CodeQL (security + extended analysis), SARIF upload |
| `semgrep.yml` | Semgrep `p/security-audit` + `p/typescript` + `p/javascript` |
| `deps.yml` | OSV-Scanner dependency gate — blocks on vulnerabilities |
| `dependabot.yml` | npm, GitHub Actions, Docker — grouped weekly updates |

- CI runs the suite against a **brand-new database**, proving the fresh-clone path end-to-end.
- `npm audit` clean; `esbuild >= 0.25.12` and `uuid >= 11.1.1` pinned via overrides.

---

## Observability & Rate Limiting

- **OpenTelemetry** (traces, metrics, logs via OTLP) with `@opentelemetry/auto-instrumentations-node`; structured pino logs; AI run/step traces; usage billing events.
- **Rate limiting**:

| Scope | Limit | Environment |
|---|---|---|
| Global `/api/*` | 100 req/min per IP | production (1000 dev) |
| `/api/provision/run` + `/api/provision/eve/ask` | 20 req/min per IP | always |
| `/api/auth/login` + `/api/auth/register` | 5 per 15 min | production (60 dev) |
| `/health`, `/api/health` | exempt | — |

Budget overrides (`AUTH_RATE_LIMIT_MAX`, `API_RATE_LIMIT_MAX`) are development-only; production keeps strict defaults.

---

## Quick Start

Prerequisites: Node.js 22+, Docker Desktop (PostgreSQL 16 & Redis 7).

```bash
git clone https://github.com/Rehan147ig/taxpro-uk.git
cd taxpro-uk
cp .env.example .env          # then fill in JWT_SECRET, DATA_ENCRYPTION_KEY, AI_API_KEY
docker compose up -d          # postgres + redis (api/worker/web optional)
npm install
npm run db:migrate -w apps/api
npm run db:seed -w apps/api
npm run dev
```

- Frontend SPA: http://localhost:5173
- API health: http://localhost:3001/api/health

Demo credentials: `demo@taxpro.ai` / `TaxProDemo123!` (admin role; seed also creates `partner@taxpro.ai`).

The default seed creates a **UK FRS 102 demo tenant** (Acme UK Ltd, GBP) with Phase B domain data and Phase C workbench readiness: an entity group, FY2026 accounting/tax periods, 3 approved UK rules, a pending mapping proposal, trial-balance document metadata, and open review items — enough to run the Workbench import → calculate flow immediately.

**Production DB setup:** run `apps/api/scripts/bootstrap-roles.sql` as superuser to create `taxpro_migrations` (schema owner) and `taxpro_app` (runtime, NOBYPASSRLS), then point `DATABASE_URL` at `taxpro_app` and `DATABASE_URL_MIGRATIONS` at `taxpro_migrations`. In production the API refuses to start if `DATABASE_URL` uses a superuser role.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | prod | `postgres://postgres:postgres@localhost:5432/taxpro` | runtime DB (must be `taxpro_app` in prod) |
| `DATABASE_URL_MIGRATIONS` | prod | same as above | migration/schema-owner DB |
| `REDIS_URL` | yes | `redis://localhost:6379` | BullMQ queues |
| `JWT_SECRET` | yes | `change-me-in-production` | signing (rejected in prod if default) |
| `DATA_ENCRYPTION_KEY` | yes | `change-me-to-a-32-character-secret` | 32-char secret |
| `TOKEN_ENCRYPTION_KEY` | prod | dev/test fallback only | encrypts OAuth tokens (GCM, 16-byte auth tag); prod refuses to start without it |
| `CORS_ORIGIN` | no | `http://localhost:5173` | allowed origin |
| `AI_PROVIDER` | no | `openai` | `openai` / `nvidia` / `interfaze` / `custom` |
| `AI_BASE_URL` | no | empty | OpenAI-compatible endpoint |
| `AI_API_KEY` | no | empty | provider key |
| `AI_MODEL` | no | empty | model id |
| `OPENAI_API_KEY` | no | empty | legacy fallback when `AI_API_KEY` empty |
| `INTERFAZE_API_KEY` / `INTERFAZE_ENDPOINT` | no | empty / `https://api.interfaze.ai/v1` | interfaze provider |
| `NETSUITE_*` | no | sandbox | NetSuite OAuth |
| `COMPANIES_HOUSE_API_KEY` | no | empty | UK benchmark harness |
| `PORT` / `NODE_ENV` | no | `3001` / `development` | server profile |
| `AI_EVAL_MODE` | no | auto | `dry-run` / `mocked` / `real` |
| `MOCK_AI` | no | unset | `1` forces mocked mode |
| `AGENT_HARNESS_FALLBACK_THRESHOLD` | no | `0.25` | real-mode harness fail threshold |
| `EVE_MODEL_TIMEOUT_MS` | no | `60000` | per-attempt model timeout |
| `TAXPRO_STORAGE_BACKEND` / `TAXPRO_STORAGE_DIR` | no | `local` / `./storage` | source-document artefact storage |
| `TAXPRO_TEST_MODE` | no | unset | integration-test safety guard (hard-fails against production DBs) |

---

## Documentation

| Doc | Contents |
|---|---|
| `docs/UK_PRODUCT_ARCHITECTURE.md` | UK-first product architecture + gap report |
| `docs/UK_COVERAGE_MATRIX.md` | explicit UK coverage contract |
| `docs/UK_NON_GOALS.md` | non-goals: no HMRC filing, no VAT MTD, no US |
| `docs/AI_EVAL.md` | eval modes + multi-agent harness contract |
| `docs/PRODUCTION_READINESS_REPORT.md` | current gates, numbers, gaps |
| `docs/ROADMAP_PRODUCTION.md` | launch checklist (Phases 1–11) + UK pilot phases |
| `docs/EXTERNAL_REVIEW_BRIEF.md` | brief for external tax-professional review |

---

## Known Gaps

**Would block production go-live:**
- External tax-professional review of engine outputs (required, not yet performed).
- Formal security audit (required, not yet performed).
- Compliance exports are structure generators — no HMRC/Companies House validator integrated.
- Real pilot validation of the UK workflow (required before any production/filing-ready claim).

---

## License

MIT.
