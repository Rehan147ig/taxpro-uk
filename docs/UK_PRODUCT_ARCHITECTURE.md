# TaxPro — UK Product Architecture

**Status:** UK-first product boundary — Phase A (product reset and safety) + Phase B (domain model and data foundations) + Phase C (UK tax-close workbench end-to-end) + Phase D (filing-ready handoff, immutable manifest, external filing record)
**Date:** 2026-08-04 (Phases C + D shipped; Phase B blocker resolved — migrations applied and verified against live Postgres/Redis)
**Branch:** master

TaxPro is a **UK-only, AI-native direct-tax operating system**. The initial
commercial wedge is UK FRS 102 (Section 29) corporation-tax provision work for
accounting firms, SME finance teams and mid-market groups.

> **Positioning:** "TaxPro turns accounting data and prior tax workpapers into
> controlled, reviewer-approved UK FRS 102 tax provisions and filing-ready
> evidence."
>
> It is **not** autonomous tax filing, generic AI chat, a generic tax engine,
> or a cheap CT600 form filler.

---

## 1. Product Boundary

### 1.1 What the UK product is

1. **Connect / import** accounting data and prior-year tax files.
2. **Map** chart of accounts and **validate** the trial balance.
3. **Calculate** current tax, deferred tax, ETR reconciliation, losses, group
   relief and supported adjustments using deterministic UK rules.
4. **Use AI to propose** mappings, identify exceptions, request evidence,
   draft explanations and cite public sources — never to decide.
5. **Route** all uncertain items through a human review queue.
6. **Generate** FRS 102 workpapers, ETR/deferred-tax schedules,
   CT600/iXBRL-ready artefacts and a signed evidence package.
7. **Lock** the approved run and hand off to the accounting firm or a
   recognised filing tool.
8. **Reuse** approved mappings, positions and workpapers next year as
   "Tax Memory".

### 1.2 Out of scope (see `docs/UK_NON_GOALS.md` for the full contract)

- **No direct HMRC filing.** CT600/iXBRL output is a "filing-ready handoff"
  (validated figures + structured artefacts), never a claim that TaxPro
  submits returns. Live filing channels (CTO GovTalk XML, MTD) are
  readiness/exports only.
- **No VAT MTD**, no payroll, no personal tax, no inheritance tax.
- **No broad international tax.** US ASC 740 is preserved, tested and
  documented but **dormant** — feature-flagged off by default
  (`TAXPRO_ENABLE_US=false`), hidden from default navigation/onboarding/demo
  data, and not wired into the default jurisdiction resolution.

### 1.3 Honesty commitments

- The product is **not** called production-ready or filing-ready until
  external tax-professional review, security review and real pilot validation
  are complete (see `docs/EXTERNAL_REVIEW_BRIEF.md`).
- Coverage claims are explicit per item: supported / partially supported /
  manual-review-only / out of scope (`docs/UK_COVERAGE_MATRIX.md`).
- Unsupported tax cases become **review items**, never silent engine output.

---

## 2. Monorepo Layout (current, 2026-08-04)

```
taxpro-mvp/
  apps/
    api/        # Hono API: auth, import, mapping, provision, agent, upload,
                #   billing, connectors (xero/netsuite), exports, health
    web/        # React 19 + TanStack Router operator workbench
    worker/     # (not a separate app — BullMQ workers run in-process or as
                #   a dedicated process via apps/api/src/worker-entry.ts)
  packages/
    tax-engine/              # deterministic Decimal.js core (US + UK FRS 102 S29)
    tax-engine-enterprise/   # UNVALIDATED exploratory: US state rules, UK group
                             #   relief, GL ELT — isolated by contract, dormant
```

### 2.1 Deliberate non-decisions (target-structure reconciliation)

The original target structure proposed many small packages
(`tax-engine-uk`, `taxpro-domain`, `taxpro-ai`, `taxpro-connectors`,
`taxpro-exports`, `taxpro-audit`, `taxpro-ui`, `config`). Per the execution
rule *"do not create empty packages merely to match the diagram — extract
packages only where they create a real ownership boundary"*, **no new packages
were created in Phase A.** Rationale:

- The existing `apps/api` + `packages/tax-engine` split already gives clean
  ownership boundaries for the two properties that matter today: deterministic
  math (engine) and everything else (API).
- The UK stack (engine + API modules) is mature and coherent; splitting it
  across new packages now would churn every caller for zero pilot benefit.
- Extraction will happen **only when a boundary proves real**, e.g.:
  - `tax-engine-uk` — if/when UK rules need independent versioning, release
    cadence, or a second consumer beyond the API.
  - `taxpro-audit` — if/when an evidence manifest consumer exists outside the
    API (e.g. a CLI verification tool).
  - `taxpro-connectors` — if/when a second ingestion app (e.g. an uploader
    worker) needs the connectors.
- This matches the mandate: "Extract packages only where they create a real
  ownership boundary."

### 2.2 Package manager note

The repository is **npm workspaces + Turborepo** (not pnpm — no
`pnpm-lock.yaml` or `pnpm-workspace.yaml` exists; CI, Dockerfile and the
lockfile are npm-native). This is preserved deliberately; migrating to pnpm
would be a cross-cutting change with no pilot benefit.

---

## 3. Architecture Principles (reused, unchanged)

| Principle | Where it lives |
|---|---|
| AI prepares, never decides | zod-validated structured outputs; deterministic engine is source of truth for official amounts |
| Humans approve official decisions | `submit-for-approval` → `partner-approve` → `lock`; `assertPartnerCanApprove` (no self-approval) |
| Locked runs immutable | `assertRunIsMutable` → `409 Conflict`; corrections create new versioned runs |
| Every material action auditable | append-only `provision_events` (DB trigger enforced) |
| Tenant isolation at DB layer | RLS + `NOBYPASSRLS` runtime role; `withTenantContext`; fails closed |
| Determinism | Decimal.js frozen config, `engine_version`, `input_data_hash`, `mapping_version_hash`, byte-reproducible XLSX/ZIP |
| Provider-neutral AI | direct OpenAI-compatible client (`eve/model-client.ts`); no Vercel AI SDK dependency; Eve is optional orchestration |

---

## 4. Gap Report (what exists vs what the UK pilot needs)

Legend: ✅ exists & wired · ⚠️ exists but partial/misleading/unwired · ❌ missing

### 4.1 Data Hub (import, entities, periods, artefacts)

| Need | Status | Notes |
|---|---|---|
| Entity / TB import | ✅ | CSV import (`/api/import`), Xero connector (UK, GBP), Companies House import |
| Entity & period model | ✅ Phase B | `entity_groups` (with parent/description), `accounting_periods`, `tax_periods` (CTA 2010 s.10: 3–12 months standard, non-standard → `needs_review` + review item); RLS + grants shipped in `0013_phase_b_domain_models` |
| Prior-year artefact import (CT600, computations, loss schedules, PDFs) | ✅ Phase B | `source_documents`: document-type taxonomy, SHA-256, provenance, versioning (`parent_document_id`, `is_current`, originals immutable), extraction-status fields |
| Original artefact storage + hashes | ✅ Phase B | `apps/api/src/lib/storage/` — `StorageBackend` interface + local backend (`TAXPRO_STORAGE_BACKEND=local`, `TAXPRO_STORAGE_DIR`); tenant-scoped versioned keys; no cloud creds committed; S3-class backend is a drop-in |
| Connector interface (real, not faked) | ⚠️ | Xero + NetSuite + QBO all real OAuth; no unified connector interface |
| Trial-balance validation | ✅ | Validation on import (400s), template export |
| QBO as a UK source | ✅ Phase A follow-up | `/api/qbo` always mounted; sync defaults `UK_FRS102` + GBP; US-specific params gated by `TAXPRO_ENABLE_US` |

### 4.2 Tax Close (UK rules)

| Need | Status | Notes |
|---|---|---|
| UK current tax (FRS 102 S29) | ✅ | `packages/tax-engine/src/uk-frs102-s29/` + tests; marginal relief, small profits, main rate, rate tables 2023–2026 |
| UK deferred tax | ✅ | `calculateUkDeferredTax`, recovery check (29.14), no-discounting (29.17) |
| ETR reconciliation | ✅ | engine + `etrAdjustmentsForMarginalRelief` wired in `provision-calculator.ts` |
| Losses / group relief | ⚠️ | group relief exists in `tax-engine-enterprise` (UNVALIDATED, dormant); standalone loss model missing |
| Supported-adjustments matrix | ⚠️ | mapping categories cover common adjustments; explicit UK coverage matrix is new (`docs/UK_COVERAGE_MATRIX.md`) |
| Rule versioning (effective date, source URL, snapshot hash, author, approval, rollback) | ✅ Phase B | `uk_rules` registry — proposals must be approved by partner/admin before use; supersede/rollback chained; runs snapshot `rules_used` at creation (approved + effective at period end) |
| Calculation explainability (inputs, rule version, assumptions, warnings) | 🟡 | run provenance hashes exist; `rules_used` per-run snapshot (Phase B); Phase C workbench runs carry a deterministic snapshot (`mapping_snapshot`, `assumptions`, `warnings` jsonb), source-document/tax-period provenance and run-detail provenance view — per-calculation assumption surface is now explicit in workbench runs; export-package assumptions.json unchanged |
| Jurisdiction resolution fails closed | ✅ | `resolveJurisdiction` now throws on missing/unrecognized values (was: silent US default); `'UK'` legacy alias → `UK_FRS102_S29` |

### 4.3 Review & Evidence

| Need | Status | Notes |
|---|---|---|
| Review queue with severity/owner/due date/status/evidence | ✅ Phase B | `review_items` extended: `owner_user_id`, `due_date`, `evidence_requested`, `document_id` |
| Review lifecycle (status machine) | ✅ Phase B | open → in_progress → waiting_for_evidence → resolved/rejected/waived; waiver requires partner/admin + mandatory reason; reopen requires reason; every move on append-only `review_item_events` (DB trigger blocks UPDATE/DELETE) |
| AI proposals: accept / edit / reject / escalate | ⚠️ | accept/reject/override exist; edit + escalate not first-class |
| Maker-checker enforcement | ✅ | RBAC roles + `assertPartnerCanApprove`; configurable policies partial |
| Immutable locked runs | ✅ | 409 on mutation; versioned corrections pattern documented |
| Evidence manifest with hashes | ✅ | package-export manifest.json (SHA-256 per file, schema v1.0.0) |

### 4.4 Filing Handoff

| Need | Status | Notes |
|---|---|---|
| Honest statuses (Draft → … → Filed Externally) | ✅ Phase D | `deriveLifecycleStage` ladder: draft → needs_review → filing_ready → filed_externally; handoff_ready_at/by + filed_externally_at/by on the run row; honest badge + honesty contract in the Workbench UI |
| CT600 figures + validation | ✅ | box set, HMRC-derived validator (CTM03925 etc.) |
| iXBRL instance/inline + structural validator | ✅ | taxonomy lock `ukgaap-frs102-2023-01-01.xsd` |
| CTO GovTalk XML | ✅ | CT600 XML for Corporation Tax Online (export only) |
| MTD readiness | ✅ | gate checklist; no submission |
| R&D claim artefacts | ✅ | RDEC/surrender package |
| External filing reference recording | ✅ Phase D | `POST /api/handoff/runs/:id/record-filing` — append-only `external_filings` row (provider, reference, submitted date, manifest checksum, confirmation doc, `supersedes_filing_id`); checksum re-verified against the deterministic manifest; run row marks `filed_externally`; honesty contract: TaxPro never claims to have filed |

### 4.5 Tax Memory

| Need | Status | Notes |
|---|---|---|
| Approved prior-year mappings reused as proposals | ✅ Phase B | `mapping_proposals` (`proposal_source=carry_forward`, `carries_forward`, `prior_mapping_id`) — prior-year approved mappings are carried forward **as pending proposals** requiring human confirmation, never applied silently |
| Mapping proposals (AI may propose; human decides) | ✅ Phase B | `POST /api/mappings/proposals` (ai/rules/manual/import/carry_forward) → `POST /api/mappings/proposals/:id/decide` (approved applies a new versioned `tax_mappings` row; rejected records reason); every decision has reviewer + reason |
| Controlled UK taxonomy | ✅ Phase B | `uk-taxonomy.ts` — 12 explicit classes; anything outside → `MANUAL_REVIEW` |
| Movement highlighting / material-change confirmation | ❌ | no period-over-period proposal flow beyond carry-forward |
| Reviewer decision memory | ❌ | decisions are audited but not surfaced as reusable "positions" |

### 4.6 UI / UX

| Need | Status | Notes |
|---|---|---|
| Professional tax-close workbench default | 🟡 | Operator UI exists (Dashboard/Data Sources/Mapping/Provision/Review Queue/Run Detail/AI Findings/Exports/Audit Events); Phase B adds Periods, Documents, Proposals & Rules, Review Items pages; **Phase C adds the Workbench page** (import → gated run → recalc → provenance) and nav wiring for the full close loop; nav is not yet Portfolio/Entities/Tax Close/Review Queue/Evidence/Exports/Rules/Settings |
| UK-first presentation | ✅ Phase A | GBP default, UK labels default, US labels only for US entities with flag on; sidebar branded "UK FRS 102 Tax Provision" |
| US UI hidden unless flag on | ✅ Phase A | flag endpoint `/api/config/flags`; US 1120 export 403 when off; QBO mounted but UK-defaulted; seed is UK by default |
| No fake metrics | ✅ | counts only |

### 4.7 Security, Ops, Quality

| Need | Status | Notes |
|---|---|---|
| RLS on all tables | ✅ | 13+ tables, NOBYPASSRLS, startup guard |
| Credential/token encryption | ✅ | AES-256-GCM (`DATA_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY`) |
| AI audit logging with sensitive-content redaction | ⚠️ | full traces persisted (`ai_runs`/`ai_steps`); no explicit redaction/minimisation layer for PII in prompt payloads |
| Rate limiting / retry / DLQ | ⚠️ | rate limits + retries exist; **no dead-letter queue** for failed jobs |
| Correlation IDs | ✅ | request-id middleware |
| CI gates | ⚠️ | lint/typecheck/unit/Trivy/CodeQL/Semgrep/OSV in CI; **Playwright E2E and UK eval not in CI** |
| Fixture-labelled AI evals | ✅ | mocked/dry-run modes; real mode separate |
| Golden UK case suite | ⚠️ | 9 real Companies House filings (eval:uk 9/9, mean 1.3 bp) are a strong nucleus; not yet an anonymised pilot-tenant golden suite with mapping-acceptance/override metrics |
| Non-Vercel deployment | ✅ | Docker compose (local), railway.json, prod compose variant |

### 4.8 Messy-data ingest hardening — Feature 1: XLSX with column mapping

Status: ✅ shipped behind `INTAKE_XLSX` (default off, per-tenant via env).

Flow: `POST /api/intake/xlsx-upload` (.xlsx/.xlsm, 20 MB, ZIP-sniffed,
SHA-256, tenant-scoped storage + `source_documents` row, parser
`intake-xlsx-v1`) → `POST /api/intake/preview` (`{ uploadId }` → sheet
names, first 20 rows per sheet, header-row candidates where ≥ 60% of
non-empty cells are non-numeric strings, plus `suggestedColumnMaps` when
the client's fingerprint matches) → `POST /api/intake/column-map`
(`{ uploadId, sheetName, headerRow, columnMap, entityId,
accountingPeriodId }` → maps user-visible columns to canonical fields,
persists the map in `intake_column_maps` keyed by
`(tenant_id, client_fingerprint)`, converts rows to the same
`ParsedCsvRow` shape and reuses `validateRow` + control totals unchanged,
then creates an `xlsx` import batch with the usual `batch.created` /
`batch.validated` events) → existing `POST
/api/intake/batches/:id/commit` gate. `GET /api/intake/column-maps` looks
up the remembered map by fingerprint for next period.

Error codes (stable, machine-readable): `UNSUPPORTED_FORMAT` (legacy
`.xls` or non-OOXML bytes rejected), `INVALID_FORMULA_REF` (formula
references an external workbook like `[Budget.xlsx]Sheet1'!A1`),
`INVALID_WORKBOOK`, `EMPTY_WORKBOOK`, `FILE_TOO_LARGE`,
`ROW_LIMIT_EXCEEDED` (20,000 rows), `UNKNOWN_SHEET`, `UNKNOWN_COLUMN`,
`UNKNOWN_FIELD`, `MISSING_REQUIRED` (map must cover `accountName`,
`accountType`, `period`), `INVALID_HEADER_ROW`, `EMPTY_COLUMN_MAP` —
plus the reused CSV validator codes (`MISSING_REQUIRED`,
`INVALID_DATE`, `INVALID_AMOUNT`, `INVALID_CURRENCY`,
`PERIOD_OUT_OF_RANGE`, `AMOUNT_MISMATCH`). Cell values (not display
strings) are read; strings are trimmed + BOM-stripped; `(1,234.56)`
parens-negatives normalize to `-1234.56`; physical row numbers are
preserved as `lineNumber`. Merged headers need no special case (exceljs
repeats the master value).

Review-item flow: none new — XLSX batches flow through the existing
suggestions → decide → commit gate, so sign-convention / bridge / asset
gates (Features 2–4) apply unchanged. `client_fingerprint = sha256(JSON
{ sortedHeaders, sheetName })` is deterministic and PII-free; RLS
`USING (tenant_id = app_current_tenant_id())` on `intake_column_maps`;
every query via `withTenantContext`; raw workbook bytes stay in the
immutable upload artifact.

---

## 5. Feature Flags: US Dormancy + Intake Hardening

- Intake hardening (`apps/api/src/config/features.ts`,
  `GET /api/config/flags` → `{ INTAKE_XLSX, INTAKE_SIGN_CONVENTION,
  INTAKE_PRIOR_BRIDGE, INTAKE_ASSET_REGISTER }`): all default off,
  enabled per-tenant via env (`INTAKE_XLSX=true`, …). Intake routes enforce
  them (`403 FEATURE_DISABLED` when off) so pilots unblock incrementally.
- `TAXPRO_ENABLE_US` (default `false`) — `apps/api/src/config/env.ts` +
  `apps/api/src/config/features.ts` (planned; see `docs/UK_NON_GOALS.md`).
- Exposed to the UI via `GET /api/config/flags` → `{ enableUs }`;
  web fails closed to UK-first defaults (`apps/web/src/lib/features.ts`).
- What is gated when `false`:
  - US-specific QBO sync parameters rejected (connector itself is always
    mounted — it is a UK data source since the Phase A follow-up; sync
    defaults to `UK_FRS102` + GBP).
  - `/api/provision/results/:id/us-1120` → 403 with explicit message.
  - Default seed creates the UK tenant only (US entity skipped).
  - UI labels/currency default to UK; US labels render only for US entities.
- What is **not** gated (deliberately): `/api/netsuite` (generic ERP
  connector, also used by UK data ingestion), UK exports, engines, tests.
  US code, tests and evals remain fully intact and passing.

---

## 6. Phase Plan (from the delivery brief)

| Phase | Scope | Status |
|---|---|---|
| **A** | Product reset: UK architecture doc, US-dormancy flag, README/roadmap/readiness language, coverage matrix, non-goals | **2026-08-04 — shipped** |
| **B** | Domain model: entities/groups/periods/source documents/mappings/evidence/review items/approvals/tax memory + migrations + RLS + API contracts + tests | **2026-08-04 — shipped** (see §8 Phase B summary) |
| C | UK tax-close workbench end-to-end (import → mapping review → calculate → exceptions → workpapers → approve/lock) with source/rule/assumption explainability | **2026-08-04 — shipped** (see §8.1 Phase C summary) |
| D | Filing-ready handoff: validated package exports, immutable manifests, external-filing recording (no HMRC submission) | **2026-08-04 — shipped** (see §8.2 Phase D summary) |
| E | Pilot readiness: synthetic UK demo tenant, firm + direct-company E2E journeys, onboarding runbook, security boundaries, known limitations | next |

Cross-cutting rules in force: small coherent commits; run checks after each
phase; never bypass failing tests (fix cause or document real blocker); never
invent tax coverage; inspect callers before schema/contract changes; prefer
adapting working components; update docs with code.

---

## 7. Environment & Verification

- Run: `npm install && npm run db:migrate -w @taxpro/api && npm run db:seed -w @taxpro/api && npm run dev`
- Checks: `npm run lint` · `npm test` · `npm run build`
- UK eval: `npm run eval:uk -w @taxpro/api`
- Integration flow: `npm run test:integration -w @taxpro/api` (needs Postgres+Redis)
- E2E: `npm run test:e2e` (needs the full stack)
- US workstream verification (flag on): `TAXPRO_ENABLE_US=true npm run db:seed -w @taxpro/api`
  then `npm run verify:us-rates -w @taxpro/tax-engine-enterprise`

See `docs/UK_COVERAGE_MATRIX.md` (coverage contract), `docs/UK_NON_GOALS.md`
(non-goals), `docs/PRODUCTION_READINESS_REPORT.md` (verification evidence).

---

## 8. Phase B Summary (domain model and data foundations)

Shipped 2026-08-04 in six coherent commits (after the Phase A QBO follow-up):

| Commit | Contents |
|---|---|
| Phase B migration + schemas | `0013_phase_b_domain_models` — `entity_groups`, `accounting_periods`, `tax_periods`, `source_documents`, `mapping_proposals`, `uk_rules`, `review_item_events` (append-only trigger), `review_items` owner/due-date/evidence/document columns, `provision_runs.rules_used`; RLS on all new tables + `qbo_connections`/`xero_connections`; grants in `migrate.ts` + `bootstrap-roles.sql` |
| Source-document artefact store | `lib/storage` (backend interface + local), `/api/documents` (upload/list/get/replace/download, 25MB cap, magic-byte sniffing, immutable originals, version chaining) |
| Periods | `modules/periods` — entity groups, accounting periods, tax periods; CTA 2010 s.10 validation; non-standard → `needs_review` + review item |
| Mapping proposals + rules | `uk-taxonomy.ts` (controlled list, unsupported → `MANUAL_REVIEW`), `/api/mappings/proposals` (create/decide/carry-forward), `/api/rules` (registry, proposals, approve/rollback/supersede), runs snapshot `rules_used` at creation |
| Review lifecycle | `/api/review-items` — status machine (open/in_progress/waiting_for_evidence/resolved/waived), evidence request/attach, human-only waiver with reason, reopen, append-only history |
| Seed + web UI | Seed: group, FY2026 periods, 3 approved UK rules, pending proposal, demo document metadata, 2 review items. Web: Periods, Documents, Proposals & Rules, Review Items pages |

**Verification (no DB):** `tsc --noEmit` clean; Phase B suites `phase-b-*`
60/60 passing (taxonomy 5, periods 6, documents 5, review lifecycle 6 + prior
suites). **Blocker since resolved (2026-08-04):** migrations 0013–0015 are now
applied to live Docker Postgres/Redis and RLS/integration gates were verified
as part of Phase C (see §8.1).

**Phase B invariants (do not weaken):** AI never decides (proposals only);
waivers are human + reason + append-only; unsupported classifications route to
`MANUAL_REVIEW`; non-standard periods are flagged; rules must be approved
before a run records them as used; source-document originals are immutable.

---

## 8.1 Phase C Summary (UK tax-close workbench, end-to-end)

Shipped 2026-08-04 (after the Phase B commit set), in coherent commits with
migrations applied to live Postgres:

| Area | What shipped |
|---|---|
| Migrations | `0014` — workbench run contract on `provision_runs` (`source_document_id`, `accounting_period_id`, `tax_period_id`, `parent_run_id` lineage, `mapping_snapshot`/`assumptions`/`warnings` jsonb, `correlation_id`, `idempotency_key` + tenant-scoped unique index), `trial_balance.source_document_id`, and the `workbench_jobs` idempotent job ledger (tenant RLS: select/insert/update policies, no DELETE/TRUNCATE for `taxpro_app`); `0015` — schema-drift fix: `connections.last_sync_at` + `sync_status` default `idle` |
| API module | `modules/workbench` — `GET /api/workbench/setup` (entity/period/TB/mapping/run state), `POST /api/workbench/import` (idempotent trial-balance import into the selected source document + period), `POST /api/workbench/runs` (gated calculation; blockers → 409/blocked response; deterministic UK engine snapshot, review items, warnings), `GET /api/workbench/runs/:id` (full provenance view), `POST /api/workbench/runs/:id/recalculate` (new versioned run, `parent_run_id` lineage), `GET /api/workbench/runs/:id/blockers` |
| Gates | `modules/workbench/gates.ts` — `evaluateRunGates` (setup completeness, mapping coverage, deterministic item determinism, locked-run immutability) + `evaluateApprovalGates` (partner approval rules, workbench-run awareness; legacy runs exempt) |
| Workbench UI | `apps/web` Workbench page (nav-labelled **Workbench**) — setup panel, import, run, exceptions/review-items panel, recalc (new version), provenance run detail; recent-runs table refreshes after run/recalc |
| Rate limiting | auth + generic API limiters read **lazy** env budgets (`AUTH_RATE_LIMIT_MAX` default 5 prod / 60 dev, launcher 200; `API_RATE_LIMIT_MAX` default 100 prod / 1000 dev) — dev E2E no longer trips 429s; `api-security` production-bounds test pins prod defaults and explicit overrides |

**Verification (live DB):** migrations 0013–0015 applied to Docker Postgres;
`npm test -w @taxpro/api` **330/330** (31 files — incl. `phase-c-workbench`
and `workbench-gates` suites and the `api-security` production-bounds test);
Playwright E2E **5/5** (auth ×3 + operator workflow + workbench
import→gated-run→recalc→provenance→tenant isolation); web build + `tsc`
clean; UK engine 118/118; enterprise 89/89; RLS enforced on all tenant-owned
tables (17 with tenant-isolation policies, incl. `workbench_jobs`).

**Phase C invariants (do not weaken):** workbench runs are deterministic snapshots
(no silent amounts — uncovered/unclassified items become review items or gate
blockers); locked runs are immutable (409); recalculation always creates a new
versioned run (never mutates); import and jobs are idempotent per
`idempotency_key`; every run carries source-document/tax-period provenance and
`rules_used`; legacy (non-workbench) runs are exempt from workbench gates.

**Phase C limits (explicit):** NOT HMRC-filing-ready — no CT600 submission, no
VAT MTD; filing-handoff states, evidence manifest completion and external
filing records are Phase D; mapping decisions still require human review;
missing depreciation metadata still routes to a review item.

---

## 8.2 Phase D Summary (filing-ready handoff, immutable manifest, external filing record)

Shipped 2026-08-04, in coherent commits with migrations applied to live
Postgres. Phase D turns "locked and approved" into a **bookkeeping handoff**:
TaxPro never submits to HMRC — it records that a filing happened elsewhere.

| Area | What shipped |
|---|---|
| Migration | `0016_phase_d_handoff.sql` — `provision_runs.handoff_ready_at` / `handoff_ready_by_user_id` / `filed_externally_at` / `filed_externally_by_user_id`, and the append-only `external_filings` table (`id`, `run_id`, `tenant_id`, `filing_provider`, `filing_reference`, `submitted_date`, `manifest_checksum`, `confirmation_document_id`, `supersedes_filing_id`, `recorded_by_user_id`, timestamps; tenant-scoped RLS: select/insert policies, no update/delete for `taxpro_app`) |
| API module | `modules/handoff` — `GET /api/handoff/runs/:id` (lifecycle stage via `deriveLifecycleStage`: draft → needs_review → filing_ready → filed_externally; honesty contract; handoff gate blockers; CT600 validation — 15 rules — and iXBRL structural checks — 14 checks; external filing list; approval trail), `POST /runs/:id/handoff-ready` (gate-checked; must be locked; one-time per run), `POST /runs/:id/record-filing` (append-only external filing record; **manifest SHA-256 re-verified against the deterministic manifest** — a tampered checksum is refused with `does not match`; `supersedes_filing_id` links re-filings; never implies TaxPro filed), `GET /runs/:id/manifest` (immutable manifest with self-hash: sha256 over the canonical JSON), `GET /runs/:id/package` (deterministic byte-identical ZIP — normalized timestamps; `x-manifest-sha256` response header) |
| Gates | `modules/handoff/gates.ts` — `evaluateHandoffGates` (run must be locked; not already handed off; CT600 valid; iXBRL valid), `evaluateFilingGate` (run locked, manifest checksum match, field completeness), `violatesMakerChecker` (self-approval is a blocker) |
| Unlock hardening | `provision.routes.ts` unlock **refuses** a run with `filed_externally_at` set (400 — corrections must be a new run version via recalculate), and clears `handoff_ready_at/by` when unlocking a locked run |
| Determinism fixes (found via live-DB tests) | (1) package/manifest exports excluded from the package's internal audit trail (`EXPORT_HANDOFF_PACKAGE`, `HANDOFF_READY`, `FILED_EXTERNALLY`) so a package's contents do not change after re-export; (2) manifest approvals pin `filed_externally_at/by = null` so the first filing cannot change the manifest (evidence chain: filing record → manifest → package), while live state stays on the run row + `external_filings`; (3) CT600 guard only surfaces the Companies House number when `externalId` matches company-number format — a 10-digit UTR no longer trips `COMPANY_NUMBER_FORMAT` |
| Workbench UI | `apps/web` WorkbenchPage filing-handoff panel on the run detail — honest lifecycle badge, honesty-contract banner, gate blockers, CT600/iXBRL validation chips, **Mark filing-ready (handoff)**, **Download filing package (ZIP)** (`taxpro-uk-filing-package-<period>.zip`), **Copy manifest SHA-256**, auto-prefill of the manifest checksum after download, external filing record form (provider/reference/submitted date/checksum/confirmation doc) with append-only filings table, approval trail, recorded-by/filed-at footer note |

**Verification (live DB):** migrations 0016 applied to Docker Postgres;
`npm test -w @taxpro/api` **367/367** (33 files — `phase-d-gates` 16 pure unit
tests incl. the CT600 band ladder and byte-identical ZIP self-verification via
jszip; `phase-d-handoff` 21 live-DB tests across lifecycle, deterministic
package+manifest, external filing record, unlock-clears-handoff, and
maker-checker; full regression 367/367); Playwright E2E **6/6** (auth ×3 +
operator workflow + workbench journey + `handoff.spec` — run → review → submit →
partner sign-off → lock → filing-ready → package download → tampered checksum
refused → external filing record → tenant isolation); web build + `tsc` clean;
monorepo lint clean (5/5 tasks); RLS on `external_filings` verified.

**Phase D invariants (do not weaken):** the filing package is byte-reproducible
across downloads (deterministic ZIP, self-verifying manifest sha256); the
manifest is immutable after the first export (approvals pinned); `record-filing`
is append-only and re-verifies the checksum; filing handoff is one-way
(filed_externally is never silently unset; unlock is refused after an external
filing is recorded); TaxPro never claims to have filed — the honesty contract is
rendered in the UI and the `run.filed_externally` audit event is bookkeeping
only.

**Phase D limits (explicit):** still NOT HMRC-filing-ready — no CT600/iXBRL
schema (XSD) validation, no CTO GovTalk XML submission, no MTD; the package is
validated against HMRC-derived rules and iXBRL structural checks only. External
CPA review, a formal security audit, and pilot gates (Phase E) remain open.
