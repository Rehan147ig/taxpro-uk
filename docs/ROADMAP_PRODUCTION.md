# TaxPro — Production Roadmap

Launch checklist. Items are ordered; each must be verified by the gates in Phase 11 before go-live.

> **Product reset (2026-08-04):** TaxPro is now a **UK-first product**. Phases 1–11 below document the engineering baseline that remains in force (all ticked). The UK pilot path is defined separately in §"UK Pilot Roadmap (Phase A–E)" and in `docs/UK_PRODUCT_ARCHITECTURE.md`. US workstream items below are preserved as dormant optionality (`TAXPRO_ENABLE_US=false`).

## Status Legend

- [ ] Not started
- [~] In progress
- [x] Done

---

## Phase 1 — Repo Hygiene & Documentation

- [x] Fix README encoding (mojibake) and refresh content (React 19, TanStack Router, Turborepo, direct AI client)
- [x] `.env.example` cleaned and complete
- [x] `docs/PRODUCTION_READINESS_REPORT.md` updated with current numbers
- [x] `docs/AI_EVAL.md` documents dry-run / mocked / real modes
- [x] `docs/ROADMAP_PRODUCTION.md` (this file)
- [x] Commit changes in logical groups (docs / SDK swap / engine / exports / security / frontend / tests)

## Phase 2 — AI SDK Strategy

- [x] Replace Vercel AI SDK with direct OpenAI-compatible client (`eve/model-client.ts`, `config/ai.ts`)
- [x] Remove `ai`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `openai` dependencies
- [x] Preserve Eve operating layer and `callJsonModel` surface
- [x] zod validation on structured output; `InvalidOutputError` on malformed output
- [x] Retry/backoff on 429/5xx/network/timeout; per-attempt timeout
- [x] Tests: provider config, missing keys, timeout, malformed output, retry behavior (16 tests)

## Phase 3 — AI Outcome Quality

- [x] Subagent lifecycle states: started / completed / failed / timeout / fallback_used (trace-store + `eve/subagent-runner.ts`, default 120s timeout, `SUBAGENT_TIMEOUT_MS` override)
- [x] Integration test waits for subagent completion or timeout (not just trace creation) — `src/__tests__/ai-subagents.test.ts` (7 tests)
- [x] Tests prove: mapping agent returns validated JSON; audit defense memo persisted; credit miner output persisted; failed AI does not corrupt deterministic results; deterministic fallback works
- [x] AI eval command with dry-run / mocked / real modes (harness exists; wire modes) — `AI_EVAL_MODE=dry-run|mocked|real`, `MOCK_AI=1` alias; **real-mode blockers fixed 2026-08-01** (eval chunks at 50 accounts/batch, stage-2 maxTokens 8192, UUID eval tenant); real-mode smoke test PASS (6/6 mappings)
- [x] Enforce ≥ 80% mapping threshold only in real/provider mode

## Phase 4 — Tax Engine Accuracy

- [x] Add placed-in-service date / asset age to trial balance & account data (`placed_in_service_date` on accounts + trial_balance, engine types, `depreciation_metadata.sql`)
- [x] Replace default first-year MACRS assumption with explicit asset metadata (per-account resolution: tb date > tb age > account date > fallback)
- [x] Missing metadata → review item + low confidence (no silent first-year assumption) — `missing_depreciation_metadata` review item, run marked needs_review
- [x] Tests: current-year asset, prior-year asset, missing date, MACRS class variation, UK no-MACRS (8 new engine tests; E2E asserts the review item)
- [x] Verify US/UK engine isolation preserved (UK/non-MACRS categories never flagged; engine freeze guards intact)

## Phase 5 — Public Data Validation

- [x] Expand EDGAR mapping: state tax, foreign rate differential, credits, valuation allowance, share-based comp, contingencies, prior-year adjustments (classified buckets in `xbrl-map.ts`; math flows unchanged)
- [x] Result categories: evaluated/pass, evaluated/warn, evaluated/fail, skipped/data unavailable, skipped/footnote does not tie (`run-eval.ts` emits category + skipReason)
- [x] Never market skipped companies as validated (summary prints VALIDATED = evaluated only + explicit "NOT validated" line)
- [x] Add more UK Companies House fixtures with provenance metadata (company, year, source doc, note ref, manual adjustments — 9 fixtures; noteRef/manualAdjustments fields added)
- [x] `docs/PUBLIC_DATA_VALIDATION.md` summarizing evidence honestly
- [x] Close EDGAR skip gap (ranked fixes in `docs/EDGAR_SKIP_GAP_REPORT.md`): P1 new-taxonomy `EffectiveIncomeTaxRateReconciliation…Amount` tag collection + P1 minority-interest negative bucket + P2 percent-unit path (tie-gated) + P2 target rotation (JKHY→FAST, WDFC→ITW) **implemented 2026-08-01** + P3 target expansion to 20 (GGG/IEX/BRC/SSD/MSM/CSL/AWI/UFPI; NDSN/FELE rejected on tie gate) + P3 additive-convention credit mapping fix (UFPI 179 bp FAIL → 19 bp PASS) + live US eval step in CI **implemented 2026-08-03** — validated 2/12 → **15/20** (12 PASS + 3 WARN, mean 17.5 bp), HSY 268→122 bp (residual ≈$14.8M is untagged XBRL lines — not recoverable by code), NUE 663→118 bp, CLX attempted via percent path (stays SKIP by tie gate)

## Phase 6 — Compliance Exports

- [x] CT600: validate box logic vs current HMRC guidance; fixture tests for small profits rate, marginal relief, main rate, credits, R&D
- [x] CT600: credits/POA exceeding the charge floor payable/balance at zero (never a hidden repayment); box-value consistency test
- [x] iXBRL: well-formed XML tests, taxonomy/version metadata, label output "validation-ready" not "filing-ready"; XML escaping and deterministic numeric tests
- [x] MTD: separate readiness checks from submission; mock HMRC API tests; malformed-response, HTTP-failure and AbortSignal timeout tests
- [x] Export package: calculation summary, assumptions, review items, AI traces, audit events, source hashes, approval trail
- [x] Test: locked package reproducible from immutable run data (byte-identical across wall-clock gaps — no volatile timestamps)
- [x] Package manifest: schemaVersion, generatedAt, period, source/mapping/engine provenance, per-file sha256 with self-exclusion, fileCount integrity
- [x] Step 2 hardening: CT600 rules conformance validator (HMRC-derived: CTM03925 MR formula `3/200 × (U − A)`, box identities, UTR/CH formats, ISO period rules, band/rate alignment FY2022+, straddle handling) wired into `/results/:id/ct600` JSON; iXBRL structural conformance validator (namespaces, schemaRef taxonomy lock, context/unit resolution, decimals, ISO dates, numeric format) carried on every generated document

## Phase 7 — Security & Governance

- [x] Runtime role guard: fail startup when NODE_ENV=production and DATABASE_URL uses a superuser role
- [x] Verify NOBYPASSRLS role usage in production
- [x] Tests: tenant isolation, missing tenant context, cross-tenant access, locked-run mutation rejection, partner cannot approve own run, audit append-only
- [x] `.env` untracked (verified), `.env.example` complete (done)
- [x] Rate limiting on auth + critical provision endpoints
- [x] Generic auth failure messages (no information leakage)
- [x] Fix pg deprecation warning in API tests

## Phase 8 — Frontend Product Completion

- [x] Finish TanStack Router migration; remove or archive old `App.tsx`
- [x] Pages align with backend: Dashboard, Connections, Mapping, Provision, Review Queue, Run Detail, AI Findings, Audit Events, Export Package
- [x] UI states: loading, empty, error, locked, needs review, awaiting partner approval, finalized
- [x] Route-level code splitting (fix > 500 kB bundle warning)
- [x] Operator workflows only — no marketing pages

## Phase 9 — API Integration Tests

- [x] Extend `test-provision-flow.ts`: login → import TB → mapping → provision → wait AI traces (polling with 120s timeout, terminal-state verification) → review items → resolve → submit → partner approval (different user) → lock → mutation 409 → export package (pre-lock basic + post-lock comprehensive with manifest/hash/fileCount) → audit events → tenant isolation
- [x] Hard test-environment safety guard (NODE_ENV + TAXPRO_TEST_MODE + DB host check; fails closed before any mutation)
- [x] Real AI trace polling with bounded timeout (800ms interval, 120s max; fails if agents still `started` or list unexpectedly empty)
- [x] Import workflow tested (POST import, GET export, validation rejection 400)
- [x] Mapping workflow tested (GET mappings, override before lock → 201, mapping.override audit event)
- [x] Post-lock package export with manifest integrity verification (all SHA-256 hashes checked against actual ZIP entry bytes, fileCount matches, required files present)
- [x] Cross-tenant isolation covers import, mappings, review items, results, package export
- [x] Deterministic seed producing at least one review item (depreciation account 5200, no placed-in-service date)
- [x] No pending agents at test completion
- [x] Runnable locally with Docker Postgres/Redis + TAXPRO_TEST_MODE=1

## Phase 10 — Production Deployment

- [x] Review Dockerfile / railway.json / docker-compose; fresh-clone build check (`npm ci && npm run build && npm test`)
- [x] Health checks: API, DB, Redis, worker status, AI provider (optional/graded)
- [x] Production env validation (fail fast)
- [x] Graceful worker shutdown
- [x] Logs/traces around every provision run

## Phase 11 — Final Verification & Report

Run and record: `npm run lint` · `npm test` · `npm run build` · `npm run test:integration -w @taxpro/api` · `OFFLINE=1 npm run eval` · `npm run eval:uk` · `npm run eval:ai-mapping -w @taxpro/api` (dry-run or mocked)

- [x] `npm run lint` — PASS (4/4 workspaces)
- [x] `npm test` — 479/479 PASS (118 engine + 272 API + 89 tax-engine-enterprise)
- [x] `npm run build` — PASS (4/4 workspaces)
- [x] `npm run test:integration -w @taxpro/api` — 27/27 PASS (full lifecycle + tenant isolation + package hash verification)
- [x] `OFFLINE=1 npm run eval` — 12 PASS / 3 WARN / 5 SKIP (of 20), mean ETR delta 17.5 bp — validated 15/20, 0 FAIL (also runs live in CI)
- [x] `npm run eval:uk` — 9/9 PASS, mean ETR delta 1.3 bp, deferred 0 bp
- [x] `npm run eval:ai-mapping -w @taxpro/api` (dry-run) — PASS, 202 golden entries, expected distribution printed

Final report: files changed, tests run, pass/fail, remaining risks, go-to-market readiness rating, required accountant/legal/security review.

> Re-verified 2026-08-02 after adding the isolated exploratory package `packages/tax-engine-enterprise` (44 new tests, zero modifications to existing code; not wired into any app). All gates green.
>
> Re-verified 2026-08-03 after the free OSS security sweep: all four CI workflows green on master — CI (lint + 479 tests on a fresh Postgres: bootstrap roles → migrate → seed; Docker build + Trivy HIGH/CRITICAL scans), Semgrep SAST (0 findings), CodeQL, OSV dependency gate; Dependabot enabled. Shipped in the sweep: GCM auth-tag enforcement, `TOKEN_ENCRYPTION_KEY` prod fail-fast, schema-drift migration `0012_provision_runs_approval`, and byte-reproducible locked-run packages (zip timestamps normalized from run `createdAt`).
>
> Re-verified 2026-08-03 (final) after the US state tax workstream: suite at 479 tests (89 in `tax-engine-enterprise`); `npm run verify:us-rates` green — 51/51 rates + 51/51 apportionment weights exact vs dated Tax Foundation 2026 snapshots; agentic rule-refresh loop (source → capture → extract → verify → diff → human approve → atomic apply → CI gate, spec in `docs/STATE_RULE_REFRESH.md`) shipped with the proposal contract consumed by the API rule-update agent. Remaining open items are data-fill/CPA items, not code: bracketed states' top-tier-only schedules, CT 10% surtax, NJ entire-net-income, KS/OK single-sales effective dates.
>
> **2026-08-04 — UK Phase A + Phase B shipped** (see `docs/UK_PRODUCT_ARCHITECTURE.md` §8). Phase A: UK-first reset, US dormancy flag. Phase A follow-up: QBO un-gated as a UK data source (sync defaults UK_FRS102/GBP; `'UK'` jurisdiction alias). Phase B: domain migration `0013` (entity groups, accounting/tax periods, source documents, mapping proposals, UK rules, review-item events + RLS), artefact store with local storage backend, period validation (CTA 2010 s.10), mapping proposals (AI proposes, human decides, carry-forward as proposals), UK rules registry with `rules_used` snapshots on runs, review lifecycle (status machine + human-only waiver with append-only audit), extended seed and minimal operator UI (Periods, Documents, Proposals & Rules, Review Items). Verification: 60/60 Phase B unit tests + full prior suite green, `tsc` clean, web build clean. **Blocker documented:** local Postgres unavailable (no Docker daemon) — migration SQL reviewed statically but not applied to a live DB; RLS/integration gates pending in an env with Postgres/Redis.
>
> **2026-08-04 — UK Phase C (tax-close workbench) shipped** (see `docs/UK_PRODUCT_ARCHITECTURE.md` §8.1). End-to-end UK workbench: `GET /api/workbench/setup` (entity/period/TB/mapping state), idempotent trial-balance import, gated calculation runs (`/api/workbench/runs` with deterministic snapshots + review items + warnings), run view with provenance, recalculate-as-new-version (lineage via `parent_run_id`), approval/lock gates, `/api/workbench/runs/:id/blockers`; Workbench UI page (import → run → recalc → provenance) wired into nav. Migrations `0014` (workbench run contract + `workbench_jobs` idempotent ledger with tenant-isolation RLS) and `0015` (`connections` schema-drift fix: `last_sync_at`, `sync_status` default `idle`). Dev-aware rate limiting (auth + generic API limiters read lazy env budgets; production keeps strict defaults, production-bounds test pins 5/100). **Phase B blocker resolved:** Docker Postgres/Redis now available — migrations 0013–0015 applied live, RLS/integration gates verified. Verification: API 330/330 (31 files, incl. `phase-c-workbench` + `workbench-gates` + `api-security` production-bounds), Playwright E2E 5/5 (auth ×3, operator workflow, workbench import→run→recalc→provenance→tenant isolation), web build + lint clean, `tsc` clean. NOT filing-ready — UK limits (HMRC validator, filing handoff, MTD submission) are explicit manual-review items; Phase D (evidence manifest, export-package completion, external filing-handoff state, external filing record) and pilot gates (E) remain.
>
> **2026-08-04 — UK Phase D (filing-ready handoff) shipped** (see `docs/UK_PRODUCT_ARCHITECTURE.md` §8.2). Honest filing-handoff lifecycle on the locked run: `handoff_ready_at/by` + `filed_externally_at/by` on `provision_runs` and the append-only `external_filings` table (migration `0016`, tenant RLS). `modules/handoff`: `GET /api/handoff/runs/:id` (lifecycle stage ladder, honesty contract, handoff gate blockers, CT600 15-rule + iXBRL 14-check validation, external filings, approval trail), `POST /runs/:id/handoff-ready` (gate-checked, one-time), `POST /runs/:id/record-filing` (append-only; manifest SHA-256 re-verified — tampered checksums refused; `supersedes_filing_id`), `GET /runs/:id/manifest` (immutable, self-hashing), `GET /runs/:id/package` (deterministic byte-identical ZIP, `x-manifest-sha256`). Unlock hardened: refused once an external filing is recorded; clears handoff-ready flags. Two real determinism bugs found and fixed via live-DB tests (export/handoff/filing events no longer mutate the packaged audit trail; manifest approvals pin filing state). Workbench UI: filing-handoff panel (honest badge, honesty contract, validation chips, download package, copy checksum, record-filing form, append-only records). Verification: API 367/367 (33 files — `phase-d-gates` 16 pure + `phase-d-handoff` 21 live-DB), Playwright E2E 6/6 (new `handoff.spec`: run → review → submit → partner sign-off → lock → filing-ready → package → tampered checksum refused → external filing recorded → tenant isolation), web build + lint clean, monorepo lint 5/5. **Still NOT filing-ready:** no CT600/iXBRL XSD validation, no CTO GovTalk XML submission, no MTD — package validation is against HMRC-derived rules and structural checks only; external CPA review, formal security audit, and pilot gates (E) remain open.
> **2026-08-05 — UK Phase 1 (enterprise data intake) + Tax Intelligence Layer shipped.** Enterprise intake (see `docs/PHASE1_ENTERPRISE_INTAKE.md`): migration `0017_enterprise_intake` — import batches/rows/events (append-only ledger), knowledge-graph foundation (`data_lineage_edges`), evidence graph (`evidence_links`), tax memory (`tax_memory_precedents`, `mapping_suggestions`), reviewer feedback (`reviewer_feedback_events`), `rule_version_hash`; `modules/intake` — multipart upload → deterministic CSV validation → suggest (tax memory + rules + bounded AI, advisory only) → decide → gate-checked commit (accounts + trial balance + lineage + supersede) → metrics; RLS fix migration `0018` (DELETE policies), intake agent tracing hardened with `tenant_id` (RLS-safe `ai_runs`/`ai_steps`). Tax Intelligence Layer (see `docs/tax-intelligence-layer.md`): migration `0019` (`source_documents` source/parser/ocr metadata + `updated_at`, `import_batches` `storage_key`/`parser_version`, append-only `agent_events` outbox with RLS/grants/trigger) + `0020` (`tax_adjustments` review lifecycle); **evidence persistence** (upload bytes → storage → `source_documents` → batch auto-link); **calc-time lineage edges** (`produced`, `used_balance`) at both calculation paths; **Provenance API** (`/api/provenance/results/:id`, `/documents/:id`, `/agents`); **eve agent framework** (`eve/agent.ts` — `defineAgent` registry, `emitAgentEvent`, `runReadOnly` `SET TRANSACTION READ ONLY` guard, telemetry-only step recorder, registered roster: platform, intake_agent, mapping_agent, audit_defense_agent, credit_miner, learning_system); **learning system** (`POST /api/intake/adjustments/:id/approve|reject` → status + immutable feedback + `learning_system` agent event, one transaction). Verification: API 391/391 (32 files — `phase-e-intake` 37 live-DB + `phase-f-intelligence` 11 live-DB added), monorepo lint 5/5, `tsc` clean (api + web), migrations 0017–0020 applied on live Postgres. **Still NOT filing-ready and NOT production-ready:** no CT600/iXBRL XSD validation, no CTO GovTalk XML submission, no MTD; external CPA review and a formal security audit remain required; pilot gates (E) remain open.
> **2026-08-05 — Phase 1E/1G follow-up shipped: run↔batch linkage, automated journal workpapers export, agent framework adoption, operator UI.** (1) **Run ↔ import-batch linkage**: `import_batch_id` (uuid, nullable, FK `import_batches.id ON DELETE SET NULL`) on `provision_runs` (migration `0021_provision_run_batch_linkage`, applied live); `lib/import-batch-link.ts` (`resolveActiveImportBatch` — only `committed` non-superseded batches auto-link via `accountingPeriods` containment; `requireCommittedBatch`; `assertRunBatchLinkageMutable` → 409 on locked runs); workbench `runSchema` accepts optional `importBatchId`, `PATCH /api/workbench/runs/:id/import-batch` (preparer+, 409 when locked), recalculate inherits linkage, provision `POST /api/provision/run` auto-links and returns `importBatchId`. (2) **Journal workpapers export** (`modules/export`): `GET /api/export/journals/:resultId?format=` — engine `detail.journalEntries` path with a derived FRS 102 S29 fallback, balanced-line controls, Xero/QBO/NetSuite/generic CSV dialects + JSON; mounted at `/api/export`; `journals-export.test.ts` (10 pure + 7 live-DB, cross-tenant 404). (3) **Agent framework adoption**: legacy swarm callbacks in the provision pipeline rewired through `agent/subagents/framework-adapters.ts` (`runMappingAgentAsAgent` / `draftAuditMemoAsAgent` / `mineCreditsAsAgent` — `runAgent` + `runReadOnly` + discovery events `mapping.proposals_generated` / `audit.memo_drafted` / `credits.opportunities_surfaced`); `agent_events.run_id` FK to `ai_runs` respected (provision run id carried in event payload, not the FK). (4) **Operator UI**: Intake page (`/intake` — drag-drop CSV upload, batch queue + detail + validation errors + row stats, suggestion generate/review/decide, gate-checked commit, adjustment review dashboard with approve/reject + reason modal emitting learning signals), Provenance visualizer (`/provenance/$resultId` — source documents → import batches → account balances → provision run → result, agent activity, adjustments, knowledge-graph edges, journal JSON/CSV downloads), provenance link from workbench run results, nav entry. Verification: API 408/408 (33 files — `journals-export` added; suite exposed and fixed a migration-file naming mismatch — the migrator resolves `<tag>.sql`, so the SQL file is `provision_run_batch_linkage.sql`), monorepo lint 5/5 (4/4 workspaces + builds), `tsc` clean (api + web), web production build clean, `eval:uk` 9/9 (mean ETR delta 1.3 bp, deferred 0 bp). **Still NOT filing-ready and not production-ready:** no CT600/iXBRL XSD validation, no CTO GovTalk XML submission, no MTD; external CPA review and a formal security audit remain required; paid-pilot and production gates (Phase E + Phase 11 §gates) remain open.

---

## Hard Constraints (do not violate)

1. No "filing-ready" claim unless a real HMRC/Companies House validator is integrated and tested.
2. No "100% accurate" claim without external CPA review and broad public-data validation.
3. Deterministic engine remains the source of truth for official amounts.
4. Human approval is mandatory before locked/final outputs.
5. Do not remove existing user work unless verified unused and obsolete.
6. The US ASC 740 workstream stays dormant behind `TAXPRO_ENABLE_US=false` — hidden from default UX, onboarding and demo data; preserved and tested, never deleted.
7. No direct HMRC filing; CT600/iXBRL output is a filing-ready handoff only (see `docs/UK_NON_GOALS.md`).

---

## UK Pilot Roadmap (Phase A–E, from the UK-first delivery plan)

| Phase | Scope | Status |
|---|---|---|
| **A — Product reset & safety** | UK architecture + gap report (`docs/UK_PRODUCT_ARCHITECTURE.md`); `TAXPRO_ENABLE_US` flag hiding US from all default UX; README/roadmap/readiness language; UK coverage matrix (`docs/UK_COVERAGE_MATRIX.md`); non-goals (`docs/UK_NON_GOALS.md`); jurisdiction resolution fails closed | **2026-08-04 — shipped** |
| **B — Domain & data model** | entity/group/period/source-document/mapping/evidence/review-item/approval/tax-memory models; migrations + RLS; API contracts + tests | **2026-08-04 — shipped** (commit set: domain migration `0013`, artefact store, periods, mapping proposals + rules registry, review lifecycle, seed + minimal UI; `phase-b-*` suites 60/60 green, `tsc` clean; migration not yet applied to live Postgres locally) |
| **C — UK tax-close workbench** | wire UK deterministic engine end-to-end in UI/API; import → mapping review → calculate → exceptions → workpapers → approve/lock; source/rule/assumption explainability | **2026-08-04 — shipped** (see §8.1 in `docs/UK_PRODUCT_ARCHITECTURE.md`; API 330/330, E2E 5/5, live Postgres/Redis verified) |
| **D — Filing-ready handoff** | validated package exports, immutable manifests, external-filing reference recording (no HMRC submission) | **2026-08-04 — shipped** (see §8.2 in `docs/UK_PRODUCT_ARCHITECTURE.md`; API 367/367, E2E 6/6) |
| **E — Pilot readiness** | synthetic UK demo tenant; firm + direct-company E2E journeys; onboarding runbook; security boundaries; known limitations | next |
