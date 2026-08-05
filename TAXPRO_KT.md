# TaxPro — Comprehensive Knowledge Transfer (KT) for AI & Systems Engineers

---

## 0. UK-First Product Reset (2026-08-04) — READ THIS FIRST

TaxPro is a **UK-first product**: controlled, reviewer-approved **UK FRS 102
(Section 29) corporation-tax provisions** and filing-ready evidence.

- **Default surface:** UK FRS 102 engine (default demo tenant Acme UK Ltd,
  GBP), UK exports (CT600, iXBRL, CTO XML, MTD readiness, R&D), Companies
  House import, Xero (UK).
- **US ASC 740 is dormant, not deleted:** gated by `TAXPRO_ENABLE_US=false`
  (`apps/api/src/config/features.ts`) — US-specific QBO sync params rejected
  (the QBO connector is a UK data source and stays mounted, UK sync defaults),
  US 1120 export 403, US seed entity skipped, US UI labels hidden,
  `resolveJurisdiction` fails closed (no silent US default). Enable only for
  US feature work.
- **Docs:** `docs/UK_PRODUCT_ARCHITECTURE.md` (architecture + gap report),
  `docs/UK_COVERAGE_MATRIX.md` (coverage contract),
  `docs/UK_NON_GOALS.md` (no HMRC filing / no VAT MTD).
- **UK phases A + B + C shipped 2026-08-04** (see §4): the UK tax-close
  workbench is now wired end-to-end (import → gated run → recalc lineage →
  provenance) and verified against live Postgres/Redis with RLS (API 330/330,
  E2E 5/5). NOT HMRC-filing-ready; filing handoff is Phase D.
- **Honesty bar unchanged:** not production-ready or filing-ready until
  external tax-professional review, security review and real pilot validation.

---

## 1. Executive Summary & Product Architecture

TaxPro Enterprise is an **AI-Native Outcome-as-a-Service (OaaS) Multi-Jurisdiction Corporate Tax Provision Platform** supporting both US (ASC 740) and UK (FRS 102 Section 29) tax regimes. 

### Fundamental Operating Model
Instead of selling complex SaaS spreadsheet interfaces, TaxPro Enterprise automates the end-to-end outcome:
1. **Ingest Financial Trial Balance** (CSV, NetSuite REST/SuiteQL, or Companies House API).
2. **AI Semantic Account Mapping** (Precedent Engine + Eve subagent swarm with active learning memory).
3. **Deterministic Tax Calculation** (Pure TypeScript math engine, `Decimal.js` monetary primitives for US ASC 740 and UK FRS 102 S29).
4. **Audit-Ready Deliverables** (4-tab `.xlsx` workpaper workbook + Zip package export with audit logs).

---

## 2. Directory & Workspaces Structure

```text
taxpro/
├── apps/
│   ├── api/                          # Hono.js HTTP Backend & Background Workers (Port 3001)
│   │   ├── scripts/
│   │   │   ├── synthetic-seed.ts     # Multi-entity multi-quarter seed generator
│   │   │   ├── run-provision-tests.ts# Automated 12-scenario provision test suite
│   │   │   ├── test-rls-governance.ts# PostgreSQL RLS isolation & fail-closed tests
│   │   │   └── eval/                 # Dual US & UK Benchmark Evaluation Harnesses
│   │   │       ├── run-sec-eval.ts   # US SEC EDGAR 10-K benchmark runner (17.5 bp mean delta, 15/20 evaluated)
│   │   │       └── run-uk-eval.ts    # UK FRS 102 Companies House benchmark runner (9/9 PASS, 1.3 bp mean delta)
│   │   ├── src/
│   │   │   ├── agent/                # Unified Subagent Architecture
│   │   │   │   ├── parser/           # Trial balance CSV/PDF extraction agent
│   │   │   │   ├── mapping/          # Two-stage GL account classification agent
│   │   │   │   ├── explanation/      # Audit-quality tax provision explanation agent
│   │   │   │   ├── audit/            # Risk & compliance audit verification agent
│   │   │   │   ├── orchestrator/     # BullMQ state machine pipeline (state-machine.ts)
│   │   │   │   └── subagents/        # Legacy specialized agents (mapping, audit-defense, credit-miner)
│   │   │   ├── eve/                  # Core Eve LLM Runtime Framework
│   │   │   │   ├── model-client.ts   # Resilient JSON caller (temperature enforcement, prompt versioning)
│   │   │   │   ├── pattern-store.ts  # Tokenized GIN-indexed fuzzy feedback memory
│   │   │   │   └── trace-store.ts    # AI execution step logging (ai_runs, ai_steps)
│   │   │   ├── db/schema/            # Drizzle PostgreSQL schemas (25 tables, 17 with tenant-isolation RLS policies)
│   │   │   ├── state/                # TaxProvisionState & assertNotLocked / transitionStage guards
│   │   │   └── modules/              # Auth, Import, Mapping, NetSuite, Provision, Export, Agent,
│   │   │                             #   Periods, Documents, Rules, Review-Items, Workbench (Phase C)
│   └── web/                          # React 18 + Vite Frontend (Port 5173)
│       └── src/
│           ├── pages/
│           │   ├── ProvisionPage.tsx # Single-click run & Excel export
│           │   ├── ReviewDashboard.tsx # Human-in-the-Loop CPA review & governance
│           │   ├── MappingPage.tsx   # Precedent mapping workspace & one-click CPA approval
│           │   └── ...
│           └── components/
│               └── AiFindingsPanel.tsx # Render audit memos, citations & tax credits
└── packages/
    ├── tax-engine/                   # Pure Tax Engine (Zero HTTP/DB deps)
    │   └── src/
    │       ├── index.ts              # calculateJurisdiction() router
    │       ├── current-tax.ts        # ASC 740-10 Taxable Income & Current Tax
    │       ├── deferred-tax.ts       # ASC 740 Deferred Tax Assets/Liabilities
    │       ├── etr-reconciliation.ts # Effective Tax Rate Walk
    │       └── uk-frs102-s29/        # UK FRS 102 S29 Deferred Tax Rules (25% Rate, No Discounting, Note 14)
    └── tax-engine-enterprise/        # Isolated exploratory group/multi-entity/GL-ELT package
                                       #   (89 tests, UNVALIDATED; only the API rule-update agent imports its proposal contract)
```

---

## 2.5 CI & Security Scanning (2026-08-03)

Four GitHub Actions workflows run on every push/PR to `master` (all green):

- `ci.yml` — Security Scan (Gitleaks advisory + Trufflehog verified secrets),
  Lint & Test against a **fresh Postgres 16 + Redis 7** (bootstrap roles →
  `db:migrate` → `db:seed` → 479 tests → build), Docker Build & Scan (API/Web
  images + Trivy HIGH/CRITICAL SARIF).
- `codeql.yml` — GitHub CodeQL (security + extended).
- `semgrep.yml` — Semgrep `p/security-audit` + `p/typescript` + `p/javascript`
  (0 blocking findings).
- `deps.yml` — OSV-Scanner dependency gate (`osv-scanner-action@v2.3.8`);
  Dependabot enabled for npm / Actions / Docker.

The fresh-DB pipeline caught real bugs in 2026-08-02/03: schema drift
(`provision_runs.approved_by_user_id` was in the TS schema but never migrated —
fixed by idempotent `0012_provision_runs_approval`) and non-byte-reproducible
locked-run packages (zip DOS timestamps now normalized from the run's
`createdAt` in UTC). Prod fail-fast now also covers `TOKEN_ENCRYPTION_KEY`
(mandatory in production), and GCM decryption enforces a 16-byte auth tag.

---

## 3. Core Architectural Principles

1. **Dual-Role PostgreSQL Row-Level Security (RLS)**:
   - `taxpro_migrations` owns schema migrations.
   - `taxpro_app` runs at runtime with `NOBYPASSRLS`.
   - All tenant queries are scoped via `set_config('app.tenant_id', tenantId, true)` inside `withTenantContext`.
2. **Append-Only Audit Trail**:
   - `provision_events` trigger `reject_provision_event_mutation()` rejects any `UPDATE` or `DELETE` attempt.
3. **Pure Zero-Float Precision (`Decimal.js`)**:
   - Monetary values across US ASC 740 and UK FRS 102 calculation paths use `Decimal.js` to eliminate IEEE 754 floating-point drift.
4. **Empirical Ground-Truth Benchmarking**:
   - Engine accuracy is continuously validated against live audited corporate filings:
     - **US SEC EDGAR 10-K Suite:** mean 17.5 bp ETR delta (15/20 filings evaluated, 0 FAIL; skips are filer-data/tie-gate, never counted as validated).
     - **UK Companies House Suite:** 9/9 PASS, mean 1.3 bp ETR variance & 0.0 bp closing deferred variance.

---

## 4. UK Phase C — Tax-Close Workbench (shipped 2026-08-04)

The workbench wires the UK deterministic engine end-to-end in API + UI, with
the Phase B blocker (no live DB) resolved — migrations 0013–0015 are applied
to live Postgres and RLS/integration gates verified.

- **Migrations:** `0014` — workbench run contract on `provision_runs`
  (`source_document_id`, `accounting_period_id`, `tax_period_id`,
  `parent_run_id` recalc lineage, `mapping_snapshot`/`assumptions`/`warnings`
  jsonb, `correlation_id`, `idempotency_key` + tenant-scoped unique index),
  `trial_balance.source_document_id`, and the `workbench_jobs` idempotent job
  ledger (tenant-isolation RLS, `taxpro_app` granted SELECT/INSERT/UPDATE only).
  `0015` — schema-drift fix: `connections.last_sync_at` + `sync_status`
  default `idle`.
- **API (`apps/api/src/modules/workbench`):** `GET /workbench/setup` ·
  `POST /workbench/import` (idempotent TB import) · `POST /workbench/runs`
  (gated calculation; deterministic snapshot + review items + warnings) ·
  `GET /workbench/runs/:id` (provenance) · `POST /workbench/runs/:id/recalculate`
  (new version, never mutates) · `GET /workbench/runs/:id/blockers` ·
  gates in `modules/workbench/gates.ts` (`evaluateRunGates`,
  `evaluateApprovalGates`; legacy runs exempt). Jobs run through BullMQ with
  the `workbench_jobs` ledger for idempotency (replayed jobs return the prior
  result).
- **UI (`apps/web`):** Workbench page (nav "Workbench") — setup panel,
  import, run, exceptions/review items, recalc, provenance run detail;
  recent-runs table refreshes after run/recalc.
- **Rate limiting (dev-aware, lazy):** `AUTH_RATE_LIMIT_MAX` (prod 5/15min,
  dev 60, launcher 200) and `API_RATE_LIMIT_MAX` (prod 100/min, dev 1000) read
  at startup; `.env.example` documents them as development-only; the
  `api-security` suite pins production defaults (5/100) and explicit overrides.
- **Verification:** API 330/330 (31 files — `phase-c-workbench`,
  `workbench-gates`, `api-security` production-bounds), Playwright E2E 5/5
  (auth ×3 + operator workflow + workbench journey), web build + lint clean,
  `tsc` clean, UK engine 118/118, enterprise 89/89; 17 tenant-owned tables
  carry tenant-isolation RLS policies (incl. `workbench_jobs`).
- **Limits:** NOT HMRC-filing-ready — no CT600 submission, no VAT MTD; filing
  handoff, evidence-manifest completion and external filing records are Phase
  D; mapping decisions stay human-owned; uncovered items become review items
  or gate blockers, never silent engine output.

---

## 5. Enterprise Intake + Tax Intelligence Layer (shipped 2026-08-05)

Foundation infrastructure — no new tax features. Every number can now answer
"where did this come from?" through persisted graph edges and an evidence trail.

- **Migrations:** `0017` `enterprise_intake` — `import_batches/rows/events`
  (append-only ledger), `data_lineage_edges`, `evidence_links`, tax memory
  (`tax_memory_precedents`, `mapping_suggestions`), `reviewer_feedback_events`,
  `rule_version_hash`. `0018` — DELETE policies for evidence links + precedents
  (0017 created SELECT/INSERT/UPDATE only). `0019` `intelligence_layer` —
  `source_documents` evidence metadata (`source_system`, `parser_version`,
  `ocr_version`, `updated_at`), `import_batches` `storage_key`/`parser_version`,
  append-only `agent_events` outbox (tenant RLS, SELECT/INSERT grants,
  `reject_agent_event_mutation` trigger). `0020` `adjustment_review` —
  `tax_adjustments` status/decided_by/decided_at/decision_reason.
- **Intake (`modules/intake`):** upload → deterministic CSV validation →
  suggestions (tax memory + rules + bounded AI, advisory only) → decide →
  gate-checked commit (accounts + trial balance + lineage + supersede prior
  batch) → metrics; AI tracing RLS-safe (agent tracer takes `tenantId`).
- **Evidence persistence (`modules/intelligence/evidence.service.ts`):** every
  intake upload stores raw bytes (tenant-scoped storage key + sha256) →
  `source_documents` → batch auto-link, so committed records trace to their
  exact source bytes; storage failure is non-fatal, DB failure cleans bytes.
- **Knowledge graph at calc time:** `produced` (run → result) and
  `used_balance` (result → account) edges written idempotently
  (`lib/lineage/edges.ts`, `ON CONFLICT DO NOTHING`) at both calc paths
  (`provision.routes.ts`, `workbench/operations.ts`).
- **Provenance API (`modules/intelligence`):** `GET /api/provenance/results/:id`
  (run, producedBy, calculatedFrom, batches, documents, adjustments, agent
  events, edges), `GET /api/provenance/documents/:id`, `GET /api/provenance/agents`
  (registry). Cross-tenant → 404 (fail closed).
- **Agent framework (`eve/agent.ts`):** `defineAgent` registry +
  `emitAgentEvent` (outbox) + `runReadOnly` (real `SET TRANSACTION READ ONLY`
  guard — agent writes fail loudly) + `recordAgentStep` (ai_steps only) +
  `runAgent`. Roster: `platform`, `intake_agent`, `mapping_agent`,
  `audit_defense_agent`, `credit_miner`, `learning_system`.
- **Learning system:** `POST /api/intake/adjustments/:id/approve|reject` —
  status transition + immutable `reviewer_feedback_events` + `learning_system`
  agent event in one transaction.
- **Verification:** API 391/391 (32 files; `phase-e-intake` 37 + `phase-f-intelligence`
  11 live-DB suites), monorepo lint 5/5, `tsc` clean (api + web), migrations
  0017–0020 applied on live Postgres.
- **Limits:** NOT filing-ready; reconciliation agent / workpaper persistence
  shipped 2026-08-05 as Phase 1E/1G (see §6).

---

## 6. Phase 1E/1G — Run↔Batch Linkage, Journal Workpapers, Agent Adoption, Operator UI (shipped 2026-08-05)

Turns intake batches and calculation runs into one auditable story, and lets
the operator drive it end-to-end in the UI.

- **Migration `0021` (`provision_run_batch_linkage.sql`):** `import_batch_id`
  (uuid, nullable, FK `import_batches.id ON DELETE SET NULL`) on
  `provision_runs`. **Migration-file convention:** the drizzle migrator
  resolves `<tag>.sql`, so the file carries the tag name, not the `NNNN_`
  prefix.
- **Batch linkage (`lib/import-batch-link.ts`):** `resolveActiveImportBatch`
  (only `committed` non-superseded batches; found via `accountingPeriods`
  containment when the run carries an `accountingPeriodId`),
  `requireCommittedBatch`, `assertRunBatchLinkageMutable` (409
  `ConflictError` once a run is locked — a locked run's story is frozen).
  Workbench `runSchema` accepts optional `importBatchId` and auto-resolves the
  active batch; `PATCH /api/workbench/runs/:id/import-batch` (roles
  preparer..admin, 409 when locked); recalculate inherits the linkage;
  provision `POST /api/provision/run` auto-links and returns `importBatchId`.
- **Journal workpapers (`modules/export/journals.ts` + `export.routes.ts`):**
  `GET /api/export/journals/:resultId?format=` mounted at `/api/export`.
  `buildJournalExport` prefers the engine's `detail.journalEntries` and falls
  back to a derived FRS 102 S29 journal (current/deferred expense, deferred
  asset/liability movement, tax payable) with balanced-line controls;
  `journalsToCsv` emits Xero / QBO / NetSuite / generic dialects (escaped,
  CRLF); `journalExportFileName`. Role-guarded (preparer+, read-only roles
  export only approved/locked results).
- **Agent framework adoption (`agent/subagents/framework-adapters.ts`):** the
  legacy provision swarm callbacks now run through the eve framework —
  `runMappingAgentAsAgent`, `draftAuditMemoAsAgent`, `mineCreditsAsAgent`
  (each `runAgent` + `runReadOnly` + `emitAgentEvent` discovery event:
  `mapping.proposals_generated`, `audit.memo_drafted`,
  `credits.opportunities_surfaced`). `agent_events.run_id` is an FK to
  `ai_runs`, so the provision run id travels in the event payload, never the
  FK column.
- **Operator UI:** Intake page `/intake` (drag-drop CSV upload, batch queue +
  row stats + validation errors, suggestion generate/review/accept/reject,
  gate-checked commit, adjustment review dashboard with approve/reject reason
  modals), Provenance visualizer `/provenance/$resultId` (documents → batches
  → balances → run → result, agent activity, adjustments, graph edges, journal
  JSON/CSV downloads via blob), provenance link on workbench results, nav.
- **Verification:** API 408/408 (33 files — `journals-export` 17 tests added),
  monorepo lint 5/5, `tsc` clean (api + web), web build clean, `eval:uk` 9/9.
- **Limits:** NOT filing-ready; journals export is a workpaper download (no
  ledger postings, no VAT/MTD); batch linkage is advisory metadata — the
  engine never reads imported balances unless the run is wired through the
  workbench.
