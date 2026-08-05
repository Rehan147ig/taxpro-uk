# TaxPro — Production Readiness Report

**Status:** Verification complete — build verified, benchmark harnesses green, integration E2E green, deployment hardening verified, UK Phases C + D (tax-close workbench + filing-ready handoff) shipped and verified against live Postgres/Redis; UK Phase 1 (enterprise data intake) + Tax Intelligence Layer shipped 2026-08-05. NOT filing-ready.
**Date:** 2026-08-01 (re-verified 2026-08-02 and 2026-08-03; UK-first product reset 2026-08-04; UK Phase C shipped 2026-08-04; UK Phase D shipped 2026-08-04; enterprise intake + tax intelligence layer shipped 2026-08-05)
**Branch:** master
**Test Suite:** 598 tests passing (118 tax-engine + 391 API + 89 tax-engine-enterprise), 0 failures
**E2E Pipeline:** Playwright 6/6 (3 auth + full operator workflow with review items, AI findings, ZIP content verification, export language check + workbench journey: import → gated run → recalc as new version → provenance → tenant isolation + handoff journey: run → review → submit → partner sign-off → lock → filing-ready → package download → tampered checksum refused → external filing record → tenant isolation); API integration flow 27/27 (in-process Hono + live Postgres, covers import → mapping → provision → AI trace polling → review → pre-lock export → submit → partner sign-off → lock → 409 → post-lock comprehensive package → audit → mapping audit → tenant isolation across 6 resources)

> **Product reset (2026-08-04):** TaxPro is a **UK-first product** (FRS 102 Section 29). The US ASC 740 workstream is preserved in full but **dormant by default** (`TAXPRO_ENABLE_US=false`): US-specific QBO sync parameters rejected (the QBO connector itself is a UK data source and stays mounted with UK sync defaults), US 1120 export returns 403, default seed is a UK tenant, US UI labels hidden, and jurisdiction resolution now fails closed instead of silently defaulting to US. All US code and tests remain intact and passing; nothing is deleted. UK architecture/gap report: `docs/UK_PRODUCT_ARCHITECTURE.md` (Phase A + Phase B shipped 2026-08-04 — domain model, artefact store, mapping proposals, rule registry, review lifecycle; **Phase C — UK tax-close workbench — shipped 2026-08-04 with the Phase B blocker resolved**: migrations 0013–0015 applied and verified on live Postgres/Redis with RLS, API 330/330, E2E 5/5; see §8.1 there; **Phase D — filing-ready handoff — shipped 2026-08-04**: migration 0016 (`handoff_ready_at/by`, `filed_externally_at/by`, append-only `external_filings` with tenant RLS), `modules/handoff` (lifecycle stage, gate-checked handoff-ready, immutable self-hashing manifest, deterministic byte-identical package, checksum-re-verified external filing records), unlock hardening, Workbench filing-handoff panel; API 367/367, E2E 6/6; see §8.2 there); coverage contract: `docs/UK_COVERAGE_MATRIX.md`; scope contract: `docs/UK_NON_GOALS.md`. This report's US benchmark rows (EDGAR 15/20, state rates 51/51) remain valid evidence for the dormant US workstream, **not** claims about the UK product.

---

## 1. Current Verification State

| Gate | Command | Result |
|---|---|---|
| Lint / typecheck | `npm run lint` | PASS (5/5 tasks) |
| Unit tests | `npm test` | 598/598 PASS (118 engine + 391 API + 89 tax-engine-enterprise) |
| Build | `npm run build` | PASS (4/4 workspaces, turbo) |
| UK Phase C + D API | `npm test -w @taxpro/api` | 367/367 PASS (33 files) — `phase-c-workbench` (setup/import/gated-run/view/lineage), `workbench-gates` (run + approval gates; legacy runs exempt), `phase-d-gates` (16 pure: handoff/filing gates, maker-checker, lifecycle ladder, CT600 band ladder, determinism, self-verifying package via jszip), `phase-d-handoff` (21 live-DB: lifecycle, deterministic package+manifest, external filing record, unlock clears handoff, maker-checker), `api-security` production-bounds (auth 5, API 100 in production; explicit overrides honored); migrations 0013–0016 applied on live Postgres, RLS verified |
| UK Phase 1 + Intelligence API | `npm test -w @taxpro/api` | 391/391 PASS (32 files, current run) — incl. `phase-e-intake` (37 live-DB: CSV parsing/validation, batch lifecycle upload→validate→suggest→decide→commit, tax memory, evidence links, lineage, metrics, RLS isolation, RBAC, advisory AI tracing) and `phase-f-intelligence` (11 live-DB: evidence bytes roundtrip, calc-time `produced`/`used_balance` edges, provenance API result/document/agents, agent registry, `runReadOnly` guard, adjustment approve/reject learning signals, cross-tenant 404); migrations 0017–0020 applied on live Postgres, RLS verified |
| Provision integration flow | `npm run test:integration -w @taxpro/api` | 27/27 PASS (reset → import → import export → import validation → mappings → override → provision → run-scoped mapping override → AI trace polling → review → depreciation metadata check → single resolve → bulk resolve → finalize → pre-lock export → submit → partner sign-off → lock → verification → post-lock 409 → post-lock comprehensive package → audit lifecycle → mapping+export audit events → create foreign tenant → tenant isolation across 6 resources → verify no pending agents) |
| Operator workflow E2E | `npx playwright test` (apps/web) | 6/6 PASS (auth x3 + provision → review items display → AI findings page → partner sign-off → lock → 409 → audit → ZIP content verification → export language check → dashboard status + workbench: import → gated run → recalc as new version → provenance → tenant isolation + handoff: run → review → submit → partner sign-off → lock → filing-ready → package → tampered checksum refused → external filing record → tenant isolation) |
| US EDGAR eval | `OFFLINE=1 npm run eval` | 12 PASS, 3 WARN, 5 SKIPPED (of 20), mean ETR delta 17.5 bp — validated 15/20, 0 FAIL; also runs live in CI (non-fatal) |
| UK eval | `npm run eval:uk` | 9/9 PASS, mean ETR delta 1.3 bp, deferred closing 0 bp |
| AI mapping eval | `AI_EVAL_MODE=dry-run npm run eval:ai-mapping -w @taxpro/api` | dry-run PASS (202 golden entries; expected distribution 55 temp / 17 perm / 130 no_diff printed) |
| Agent harness (mocked) | `AI_EVAL_MODE=mocked npm run harness -w @taxpro/api` | PASS (16 fixtures, 0% fallback mocked; real 2.1% fallback Aug 2026) |
| CI workflows (GitHub Actions, master) | all 4 workflows (`ci.yml`, `codeql.yml`, `semgrep.yml`, `deps.yml`) | PASS — CI (lint + 479 tests on a fresh Postgres: bootstrap roles → migrate → seed + Docker build with Trivy HIGH/CRITICAL scans), Semgrep SAST 0 findings, CodeQL, OSV dependency gate — all green on master |
| Docker compose E2E | `docker compose -p taxpro-gate up -d --build` | 5/5 containers healthy: api (migrations + seed + RLS validation PASS), worker (all 4 workers, RLS PASS), web (nginx SPA + API proxy), postgres, redis |
| Graceful shutdown | SIGTERM → worker | PASS — `[Worker] Shutdown signal received` → `Workers closed` → exit 0 |
| Prod env fail-fast | `NODE_ENV=production` + weak JWT secret | PASS — refuses to start |
| Prod env fail-fast | `NODE_ENV=production` + superuser DATABASE_URL | PASS — `assertRuntimeDbRole` refuses to start |
| Health checks | `GET /health`, `GET /api/health` | PASS — `{db: connected, redis: connected, checks: {db: true, redis: true, rls: true}}` |

### 1.1 UK FRS 102 Benchmark (Companies House fixtures)

9 manually-curated real filings, ETR deltas 0–5 bp, deferred closing 0 bp:

| Company | CH Number | Period End | ETR delta |
|---|---|---|---|
| Greggs plc | 00502851 | 2024-12-28 | 5 bp |
| Greggs plc | 00502851 | 2025-12-27 | 3 bp |
| Finsbury Food Group Limited | 00204368 | 2025-06-28 | 1 bp |
| Tesco PLC | 00445790 | 2026-02-28 | 1 bp |
| Tesco PLC | 00445790 | 2025-02-22 | 1 bp |
| Costa Limited | 01270695 | 2024-12-31 | 1 bp |
| Vodafone Limited | 01471587 | 2025-03-31 | 0 bp |
| Farmfoods Limited | SC030186 | 2024-12-28 | 0 bp |
| Tiny Rebel Limited | 07582051 | 2023-12-31 | 0 bp |

The Tiny Rebel fixture exercises a genuine marginal-relief disclosure ("Tax at marginal rate" line in the ETR reconciliation) at the blended 23.52% transition rate.

### 1.2 US ASC 740 Benchmark (SEC EDGAR)

20 targeted 10-K filers. Harness semantics: PASS ≤ 25 bp, WARN ≤ 100 bp, SKIP = footnote data inadequate to test the engine (no itemized recon, or footnote does not tie internally). **SKIP is not validation.** Offline mode currently resolves 12 PASS / 3 WARN / 5 SKIPPED (mean ETR delta 17.5 bp). P1 + P2 fixes implemented 2026-08-01: new-taxonomy dollar-tag collection + minority-interest bucket (CHD/ROL/POOL → PASS, HSY 268→122 bp, NUE 663→118 bp), percent-unit path (CLX attempted, stays SKIP by tie gate), and target rotation (JKHY → FAST, WDFC → ITW — both WARN). P3 implemented 2026-08-03: target expansion to 20 (GGG, IEX, BRC, SSD, MSM, CSL, AWI, UFPI; NDSN/FELE rejected on the tie gate), additive-convention credit mapping fix (UFPI 179 bp FAIL → 19 bp PASS — credits disclosed as additive impacts now flow as-filed via `otherAdjustments` when the flip heuristic is not applied), and a live US EDGAR eval step in CI. Validated improved from 2/12 → 15/20, mean 32.7 → 17.5 bp, with zero FAIL. The remaining 5 skips (CLX, HSY, BRO, TYL, NUE) are filer-data/tie-gate by design — HSY's residual ≈$14.8M gap is untagged XBRL lines (all recon tags enumerated; not recoverable by code).

Expansion of EDGAR coverage (state tax, valuation allowance, credits, contingencies mapping) is an active workstream — see `docs/ROADMAP_PRODUCTION.md` and `docs/PUBLIC_DATA_VALIDATION.md`.

### 1.3 Isolated exploratory package (added 2026-08-02)

`packages/tax-engine-enterprise` (multi-entity model, UK group relief, US state tax rule engine — machine-readable rates/weights/rulesets for all 51 jurisdictions, valuation-allowance scheduler, quarterly ASC 740-270 mechanics, GL ingestion ELT) is a new, deliberately isolated workspace package: lint PASS, 89/89 unit tests PASS, build PASS, zero modifications to any existing file. The only cross-package consumer is the API's `rule-update-agent` subagent, which imports the machine-checkable proposal contract (`us/proposals.ts`) for the agentic rule-refresh loop — the computation engine is still not wired into any route, UI, engine factory, or jurisdiction resolver. **The state tax data layer is verified against dated public snapshots** (51/51 rates + 51/51 apportionment weights exact vs Tax Foundation 2026, via `npm run verify:us-rates`), but the package as a whole is **UNVALIDATED** for real ERP data — built from public reference material only, not reviewed by a CPA/attorney and not validated against a real ERP export; it must not be wired into production until reviewed. Every assumption is catalogued in `packages/tax-engine-enterprise/ASSUMPTIONS.md`; the rule-refresh workflow is specified in `docs/STATE_RULE_REFRESH.md`.

### 1.4 Fresh-DB CI pipeline (2026-08-03)

CI now runs the suite against a brand-new Postgres (bootstrap roles → `db:migrate` → `db:seed` → tests), which surfaced two real bugs now fixed and regression-guarded by the pipeline:

- **Schema drift:** `provision_runs.approved_by_user_id` existed in the TypeScript schema but no migration ever created the column — dev DBs had drifted via manual ALTERs while fresh DBs (CI/prod) were broken. Fixed by idempotent migration `0012_provision_runs_approval` (`ADD COLUMN IF NOT EXISTS`).
- **Byte-reproducibility:** exceljs' internal JSZip stamped every zip entry with wall-clock time at 2s DOS granularity, so locked-run packages were not byte-reproducible across wall-clock gaps. Fixed in `excel-generator.ts` by normalizing all zip DOS timestamps from the run's immutable `createdAt` (UTC) — verified 0-byte diff across a 3s gap.

### 1.5 US state tax rule engine + agentic rule-refresh loop (2026-08-03)

The US direct-tax problem is an open-system freshness problem: 51 jurisdictions churn rates, structures, and apportionment weights every year. Solution shipped end-to-end (spec: `docs/STATE_RULE_REFRESH.md`):

- **Machine-readable rulesets for all 51 jurisdictions** in `packages/tax-engine-enterprise/src/us/state-rules.ts` — filing type (`cit` / `grossReceipts` / `none`), rate schedule (flat or bracketed top-tier), apportionment weights, per-row verify checklist and not-modeled gaps (bracketed states store only the top tier — warning; CT 10% surtax; NJ entire-net-income). Single-sales default; EQUAL weights for AK/HI/KS/ND/NM/OK; double-weighted sales (0.25/0.25/0.5) for FL/VA.
- **Live-source verifier** (`src/us/verify-rates.ts` + `npm run verify:us-rates`): the engine is compared to **dated** snapshots in `src/us/external-snapshots.ts` — `TF_2026_RATES` (Tax Foundation 2026, published 2026-01-05, updated 2026-04-02, captured 2026-04-02) and `TF_2026_APPORTIONMENT` (Tax Foundation TaxEDU "State Primary Apportionment Factors for Tax Year 2026", captured 2026-08-03). Result: **51/51 rates and 51/51 apportionment weights exact**. The initial snapshot had 25/51 stale rates and 8/51 wrong weights (DE/MT were wrongly three-factor; KS/ND/NM/OK are actually three-factor; FL/VA double-weighted) — all corrected and locked by the verifier.
- **Agentic rule-refresh loop** (`apps/api/src/agent/subagents/rule-update-agent.ts`): an Eve subagent reads the rules from source, extracts structured proposals into the machine-checkable `RulesetProposal` contract (`us/proposals.ts` — provenance forced from the input, never invented), validates them deterministically, diffs against the current ruleset, and presents them for **human approval** before atomic application; the `verify:us-rates` CI gate re-checks the whole table after every ruleset change. KS (single-sales-factor enacted 2024, effective date to confirm) and OK (single-sales election) remain flagged for CPA sign-off.
- 89 enterprise tests (up from 44) cover the rulesets, verifier, proposal contract (11 tests), and rule-update agent (3 tests); the state-tax integration test (`us/spec/state-integration.test.ts`) runs in the main suite and in CI.
- **What is still UNVALIDATED:** CPA/attorney sign-off on the remaining data flags (brackets, CT surtax, NJ) and real-ERP validation of the computation engine. The loop's step 6 (human approval) is the gate for these.

---

## 2. Security

| Check | Status | Details |
|---|---|---|
| RLS policies on all tenant tables | PASS | 17 tables with tenant-isolation RLS policies (incl. the Phase C `workbench_jobs` ledger); `taxpro_app` has no DELETE/TRUNCATE on it |
| `withTenantContext` sets `app.tenant_id` per transaction | PASS | `set_config('app.tenant_id', ..., true)` |
| `requireRunAccess` rejects cross-tenant | PASS | `ForbiddenError('Cross-tenant access denied')` |
| RLS fails closed (no context = no rows) | PARTIAL | Requires `taxpro_app` role (NOBYPASSRLS) — dev uses superuser |
| `.env` not tracked | PASS | git-ignored |
| `.env.example` documents all vars | PASS | Includes AI provider, Interfaze, NetSuite, CH API key |
| Startup env validation (zod) | PASS | `env.ts` |
| Production JWT secret guard | PASS | `env.ts` rejects default secret in production |
| Secrets in source | PASS | Zero found in `src/` |
| Semgrep SAST (security-audit + TS/JS) | PASS | 0 findings (106 rules, 284 files) — incl. GCM decrypt now enforcing `authTagLength: 16` (`lib/crypto.ts`, `xero-client.ts`) |
| GitHub CodeQL | PASS | security + extended analysis, SARIF uploaded, green on master |
| OSV-Scanner dependency gate | PASS | 0 vulnerabilities (npm audit also 0; overrides pin esbuild ≥ 0.25.12, uuid ≥ 11.1.1) |
| Trivy container scan | PASS | API + Web images, HIGH/CRITICAL only, SARIF uploaded |
| Gitleaks / Trufflehog | PASS | gitleaks advisory (`continue-on-error`) + trufflehog `--only-verified`; Dependabot enabled (npm/Actions/Docker) |
| `TOKEN_ENCRYPTION_KEY` fail-fast | PASS | production refuses to start with the dev/test fallback key (encrypts OAuth connection tokens, GCM) |

### Runtime role guard (implemented, Phase 7)

Production must connect as `taxpro_app` (NOBYPASSRLS). `assertRuntimeDbRole` (`config/db-role-guard.ts`) fails fast at startup when `NODE_ENV=production` and `DATABASE_URL` uses a superuser-like role (postgres/root), while `validateRuntimeRoleSecurity()` refuses to start in non-development if the connected role bypasses RLS or owns tenant tables. Dev still uses superuser (documented limitation).

---

## 3. Concurrency & Locking

| Check | Status |
|---|---|
| `requireRunAccess` FOR UPDATE support | PASS |
| `assertRunIsMutable` uses FOR UPDATE | PASS |
| Lock endpoint uses FOR UPDATE | PASS |
| Locked runs reject mutation with 409 | PASS |
| Cross-tenant concurrent operations | PASS (RLS + app-layer) |
| Runtime role guard (prod superuser fail-fast) | PASS | `assertRuntimeDbRole` in `config/db-role-guard.ts` + `env.ts`; unit-tested |
| NOBYPASSRLS role verification | PASS | `validateRuntimeRoleSecurity()` fails startup in non-dev; `taxpro_app` privilege assertions (append-only `provision_events`) |
| Partner cannot approve own run | PASS | `assertPartnerCanApprove` in rbac + tests |
| Auth generic failure messages | PASS | login `Invalid email or password`; register returns generic `Registration failed` (no account-existence leak) |
| Rate limiting | PASS | login/register 5/15min (prod default; 60 dev, launcher 200), global `/api/*` 100/min (prod default; 1000 dev), strict 20/min on `/api/provision/run` + `/api/provision/eve/ask`; budgets read lazily at startup (`AUTH_RATE_LIMIT_MAX`/`API_RATE_LIMIT_MAX` dev-only overrides documented in `.env.example`); production-bounds test pins prod defaults 5/100 |
| pg deprecation warning | FIXED | subagent traces now write through the shared pool (one connection per agent), not the transaction client |

---

## 4. Data Integrity & Determinism

| Check | Status |
|---|---|
| Decimal.js config frozen | PASS |
| `createEngine` jurisdiction factory isolation | PASS |
| Large-number precision ($10B × 21%) | PASS |
| `calculateCurrentTax` × 100 identical | PASS |
| `stableHash` deterministic | PASS |
| Engine current tax, deferred, ETR walk, rollforward, journal entries | PASS |
| Marginal relief (UK S29) rules + tests | PASS |

---

## 5. AI Layer

| Check | Status |
|---|---|
| Provider abstraction (openai/nvidia/interfaze/custom) | PASS — direct OpenAI-compatible client, no Vercel AI SDK |
| zod validation of structured model output | PASS — `InvalidOutputError` on malformed output |
| Retries + timeout | PASS — tested against mock server |
| Trace lifecycle started/completed/failed | PASS |
| Trace lifecycle timeout/fallback_used | PASS |
| AI mapping eval (dry-run/mocked/real modes) | PASS |
| Minimum accuracy threshold enforced in real mode only | PASS |
| Multi-agent harness (`npm run harness`): mapping/audit-defense/credit-miner | PASS — 16 fixtures, structural assertions only (deterministic engine stays source of tax math), fallback-rate threshold 25% in real mode, trend log `agent-harness-trend.jsonl` (git-ignored), provider-outage exits 0 (mirrors `run-ai-mapping-eval.ts`) |
| Credit-miner confidence schema (`z.coerce.number()`) | PASS — numeric provider confidence now validates (`Expected string, received number` regression fixed; guarded by unit test + `credit-old-bug-numeric-confidence` fixture) |

---

## 5.5 Compliance Exports (Phase 6)

| Check | Status | Details |
|---|---|---|
| CT600 box layout (CT600 2016+) + consistency flags | PASS | main rate, small profits, marginal relief (HMRC example), credits, R&D, POA, loss-year zeroing; payable/balance floored at 0 (no hidden repayment) |
| CT600 fixtures vs HMRC guidance | PASS | small-profits 19% band, HMRC marginal relief example, RDEC/surrendered-loss boxes |
| CT600 rules conformance validator | PASS | every CT600 JSON export validated (`validation` in response) against HMRC-derived rules: UTR/CH number formats, ISO period ≤ 18 months, box identities (15 = 12+13−14, 19 = 15−16−17, 22 = 19−20), band selection, rate alignment per regime (19% ≤ £50k; MR `3/200 × (£250k − A)` per CTA 2010 s.18D/CTM03925; 25% ≥ £250k; flat 19% FY2022 & earlier); straddling 1 Apr 2023 periods skipped with reason |
| iXBRL structural conformance validator | PASS | each instance/inline document carries a build-time `validation` verdict: root + namespace declarations, schemaRef taxonomy lock (`ukgaap-frs102-2023-01-01.xsd`), context/unit resolution for every fact, `decimals="2"`, ISO context dates matching document period, finite 2-dp numeric facts, Companies House identifier scheme |
| iXBRL instance + inline docs | PASS | well-formed XML, contexts/units/facts, escaping (company names, CH numbers, `& < > " '`), deterministic numeric rendering |
| iXBRL taxonomy/version metadata | PASS | schemaRef `ukgaap-frs102-2023-01-01.xsd`, `readyStatus: 'validation_ready'` honesty contract |
| MTD readiness vs submission separation | PASS | `buildMtdReadinessReport`/`assertMtdEligible` gate; sandbox `MtdClient` mock tests (token success/failure, malformed token, HTTP failure, AbortSignal timeout); live channel = CTO GovTalk XML (CT MTD API still private beta) |
| Export package contents | PASS | xlsx + audit CSV + review-items CSV + AI-traces CSV + approval-trail JSON + assumptions JSON + manifest.json (SHA-256 per file) + summary |
| Locked-run reproducibility | PASS | byte-deterministic ZIP (workbook metadata + all zip DOS timestamps normalized from the run's immutable `createdAt` in UTC — no wall-clock data); byte-identical across a 3s wall-clock gap; tests generate twice with a delay gap and assert equality |
| Package manifest integrity | PASS | schemaVersion, generatedAt, period, source/mapping/engine provenance, per-file SHA-256 verified against actual entry bytes, manifest excludes itself, fileCount matches archive |

---

## 6. Known Gaps

### Would block production go-live
- External CPA review of engine outputs (required, not yet performed).
- Formal security audit (required, not yet performed).
- Compliance exports (CT600/iXBRL/MTD) are structure generators with deterministic, reproducible packages (Phase 6) — exports are now **validated against HMRC-derived CT600 rules and iXBRL structural conformance checks (Step 2 hardening), but still not filing-ready**: no HMRC/Companies House schema (XSD) validation or submission validator is integrated.
### Must fix before major release
- US EDGAR eval coverage: 5/20 filings skipped (CLX/HSY percent or untagged tie-gated, BRO/TYL/NUE footnote items do not tie to disclosed totals — all filer-data issues, engine not at fault; full root-cause breakdown in `docs/EDGAR_SKIP_GAP_REPORT.md`).
- Real-mode AI verified via the agent harness with a funded key (16/16 fixtures PASS, 2.1% fallback, Aug 2026). The official mapping eval now runs real mode end-to-end: the stage-2 `max_tokens: 4096` truncation blocker is fixed (eval chunks at 50 accounts/batch mirroring the production auto-mapper + stage-2 `maxTokens: 8192`) and the `eval-tenant` non-UUID is fixed (eval now generates a real UUID). Real-mode smoke test against interfaze/gpt-4o-mini passed (6 accounts, 2 batches, 6/6 mappings). The chunked workaround previously measured fully-correct mapping at 79.2%/75.2% (below the 80% gate) — mapping quality remains a known gap pending a full real-mode re-run.
### Resolved in Phase 9 hardening
- Integration test now waits for AI subagent traces to terminal states (polling with 120s timeout, 800ms interval). No false success when agent list is empty — the test fails if traces are expected but absent.
- Import and mapping APIs are now tested end-to-end in the integration flow (POST import, GET export, validation rejection, mapping override, audit events).
- Hard test-environment safety guard prevents integration test from executing against production databases.
- Post-lock package export has comprehensive manifest verification: all SHA-256 hashes checked against actual ZIP entry bytes, fileCount matches content, required files (review-items.csv, ai-traces.csv, approval-trail.json, assumptions.json) verified present.
- Tenant isolation now covers 6 resources: review items, results, package export, mappings, import data, trial balance.
- Playwright E2E strengthened: review items display verified, AI findings page checked, ZIP content verification, export page language check, dashboard status verification.

### Resolved (Phase 8)
- Frontend bundle > 500 kB warning — heavy pages (Review Queue, Run Detail, AI Findings, Audit Events, Export Package) code-split via `lazyRouteComponent`.

---

**Re-verified 2026-08-05 after UK Phase 1 (enterprise data intake) + Tax Intelligence Layer:** API 391/391 (32 files — new `phase-e-intake` 37 live-DB tests: batch lifecycle upload→validate→suggest→decide→commit, supersede, tax memory, evidence links, lineage, metrics, RLS isolation, RBAC, advisory AI tracing, `rule_version_hash`; and `phase-f-intelligence` 11 live-DB tests: evidence bytes roundtrip to storage + `source_documents`, calc-time `produced`/`used_balance` knowledge-graph edges, provenance API (results/documents/agents), agent registry + `runReadOnly` guard, append-only `agent_events` mutation rejection, adjustment approve/reject learning signals, cross-tenant provenance 404), monorepo lint 5/5, `tsc` clean (api + web), API build green; migrations 0017–0020 applied on live Docker Postgres (append-only `agent_events` trigger + grants verified). Live-DB verification surfaced and fixed an RLS bug in migration 0017 (evidence-link and precedent tables had no DELETE policy — remediated by `0018_intake_delete_policies`). **Still NOT filing-ready and not production-ready:** no CT600/iXBRL XSD validation, no CTO GovTalk XML submission, no MTD; external CPA review and a formal security audit remain required; paid-pilot and production gates (Phase E + Phase 11 §gates) remain open.

## 7. Recommendation

**Not yet production-ready — launch checklist complete, external review pending.** All Phase 10–11 gates verified (2026-08-01, re-verified 2026-08-02 and 2026-08-03): lint (4/4), 479 unit tests (390 existing + 89 isolated enterprise), build (4/4), 27/27 API integration flow, 4/4 Playwright, US EDGAR offline eval (12 PASS / 3 WARN / 5 SKIP — 15/20 validated after P1–P3 fixes, mean 17.5 bp, 0 FAIL, skip reasons documented, engine not at fault; live CI step added), UK eval 9/9 (mean 1.3 bp), AI mapping eval dry-run + real-mode blockers fixed (smoke test PASS), agent harness (mocked), docker-compose E2E 5/5 healthy, graceful worker shutdown exit 0, prod env fail-fast (weak JWT secret + superuser role both refused), health checks green (db/redis/rls). Re-verified 2026-08-03 after the free OSS security sweep: all four CI workflows green on master (CI job with the fresh-Postgres bootstrap→migrate→seed pipeline + Trivy container scans; Semgrep SAST 0 findings; CodeQL; OSV dependency gate; Dependabot active), prod fail-fast extended to `TOKEN_ENCRYPTION_KEY`, GCM auth tag enforced, schema-drift migration `0012_provision_runs_approval` landed, and locked-run packages are byte-reproducible across wall-clock gaps (zip timestamps normalized). US workstream completed 2026-08-03: benchmark validated 15/20 (mean 17.5 bp) with the additive-credit mapping fix (UFPI FAIL → PASS); compliance exports extended with a Form 1120-ready builder (`us-1120.ts` + IRS conformance validator + `/results/:id/us-1120` route, 19 new tests) mirroring the CT600 honesty contract ("validation-ready, not filing-ready"); enterprise US complexity mechanics added (valuation-allowance scheduler, quarterly ASC 740-270 interim provision, 50-state reference table — now 89 tests) and the agentic rule-refresh loop shipped (2026-08-03): machine-readable rulesets + live-source verifier for all 51 jurisdictions — rates and apportionment weights **51/51 exact vs dated Tax Foundation 2026 snapshots** (`npm run verify:us-rates`, CI-gated), proposal contract consumed by the API rule-update agent with human-approval gating; the computation engine remains UNVALIDATED for real ERP data and unwired from any app. Remaining order: external CPA review + security audit before any go-live or "filing-ready" claim. Remaining EDGAR skips are filer-data/tie-gate by design (see `docs/EDGAR_SKIP_GAP_REPORT.md` §4); the real-mode mapping eval is unblocked for a full re-run (chunking + UUID tenant fixed).

**Re-verified 2026-08-04 after UK Phase C (tax-close workbench):** API 330/330 (31 files), Playwright E2E 5/5 (added the workbench journey: import → gated run → recalc-as-new-version → provenance → tenant isolation), web build + lint clean, `tsc` clean, UK engine 118/118, enterprise 89/89; migrations 0013–0015 applied on live Docker Postgres/Redis and RLS verified — the Phase B blocker (no live DB) is resolved. Rate limiter budgets are now lazy + dev-aware with a production-bounds test (prod defaults: auth 5/15min, API 100/min; dev: 60/1000; dev launcher raises auth to 200). **Still NOT filing-ready and not production-ready:** external CPA review and a formal security audit remain required; UK filing-handoff states, evidence-manifest completion and external filing records are Phase D; paid-pilot and production gates (Phase E + Phase 11 §gates) remain open.

**Re-verified 2026-08-04 after UK Phase D (filing-ready handoff):** API 367/367 (33 files — new `phase-d-gates` 16 pure unit tests and `phase-d-handoff` 21 live-DB tests covering the honest lifecycle ladder, deterministic package + immutable manifest, external filing record with checksum re-verification, unlock-clears-handoff, and maker-checker), Playwright E2E 6/6 (added the handoff journey: run → review → submit → partner sign-off → lock → filing-ready → deterministic package download → tampered manifest checksum refused → external filing recorded → tenant isolation), web build + lint clean (5/5 tasks), `tsc` clean; migration 0016 applied on live Postgres (`handoff_ready_at/by`, `filed_externally_at/by`, append-only `external_filings` with tenant RLS). Live-DB verification surfaced and fixed two real determinism bugs (export/handoff/filing events no longer mutate the packaged audit trail; manifest approvals pin filing state so a filing cannot change the manifest) plus a CT600 guard fix (UTR no longer mistaken for a Companies House number). Unlock is now refused after an external filing is recorded — corrections must be a new run version. **Still NOT filing-ready and not production-ready:** no CT600/iXBRL XSD validation, no CTO GovTalk XML submission, no MTD; external CPA review and a formal security audit remain required; paid-pilot and production gates (Phase E + Phase 11 §gates) remain open.
