# Phase 1 — Enterprise Data Intake: Architecture Note

**Status:** implemented (migration `0017_enterprise_intake`)
**Scope:** import batches, knowledge graph foundation, evidence graph, tax memory, reviewer-feedback learning, bounded intake agents, deterministic controls.

## 1. Design principles (unchanged from the product core invariant)

1. **AI proposes, never decides.** Every AI output is zod-validated, persisted as an `ai_runs` trace, and reviewable. Low-confidence or material AI output creates review items — never an automatic tax decision.
2. **The deterministic engine is the source of truth.** Import validation, control totals and calculation math are deterministic code paths.
3. **Humans approve.** A batch reaches `committed` only through an explicit reviewer action (`commit`); accepted mapping suggestions are applied only at commit and are recorded with reviewer identity and reason.
4. **Immutable + auditable.** `import_batch_events` is append-only (DB trigger, same convention as `provision_events`). Committed batches cannot be mutated; corrections are new batches (supersede).
5. **Tenant-scoped at the database layer.** All new tables use RLS `tenant_id = app_current_tenant_id()` with `NOBYPASSRLS` runtime role, mirroring every existing tenant table.

## 2. What already exists (reused, not duplicated)

| Need | Existing table/module |
|---|---|
| Versioned source artefacts | `source_documents` (+ storage backend, SHA-256, `is_current`, `parent_document_id`) |
| Trial balance rows | `trial_balance` (unique per tenant/entity/account/period/source) |
| Accounts, entities, periods | `accounts`, `entities`, `accounting_periods`, `tax_periods` |
| Approved mappings + versions | `tax_mappings` (versioned, `is_active`, supersede-by-version) |
| AI proposal gate | `mapping_proposals` (propose ≠ decide; human decides) |
| Review exceptions | `review_items` (`provision_run_id` nullable → usable pre-run for intake exceptions) |
| Rule registry | `uk_rules` (approval states, versions) |
| Calculation provenance | `provision_runs` (`input_data_hash`, `mapping_version_hash`, `rules_used`, `mapping_snapshot`, `parent_run_id`) |
| Agent traces | `ai_runs` / `ai_steps` via `eve/` |
| Feedback patterns (legacy) | `classification_patterns` (written by mapping decisions) |
| AI mapping suggestion logic | `modules/import/auto-mapping/precedent-engine.ts` |

## 3. New domain model (migration `0017_enterprise_intake`)

### 3.1 Import batches — the intake root node

- `import_batches` — `id, tenant_id, entity_id, accounting_period_id, source_document_id` (the raw uploaded file as a versioned source document), `source_type` (`csv | netsuite | xero | warehouse | api`), `source_system`, `source_reference`, `original_filename`, `checksum` (SHA-256), `row_count`, `status` (`draft → validating → ready_for_review → committed | failed`, `superseded`), `validation_summary` (jsonb: counts by error code), `control_totals` (jsonb: total debit/credit/balance + difference), `created_by_user_id`, `reviewed_by_user_id`, `committed_at`, `superseded_by_batch_id`, timestamps.
- **Idempotency:** unique `(tenant_id, entity_id, accounting_period_id, source_type, source_system, checksum)`. Re-uploading the same file for the same entity/period/source returns the existing batch instead of creating a duplicate. A commit supersedes any earlier committed batch for the same identity (previous becomes `superseded`, linked via `superseded_by_batch_id`).
- `import_batch_rows` — one row per CSV record: `row_number`, `raw` (original record), `normalized` (parsed fields), `validation` (row-level errors/warnings, machine-readable codes), `status` (`ok | error | warning | committed | skipped`), `account_id` (resolved at commit), `committed_trial_balance_id`.
- `import_batch_events` — append-only lifecycle event ledger (`batch.created | batch.validated | batch.suggestions_generated | batch.evidence_linked | batch.committed | batch.failed | batch.superseded`). DB trigger rejects UPDATE/DELETE; runtime role has no DELETE.

### 3.2 Knowledge graph foundation

- `data_lineage_edges` — persisted, typed edges `(source_kind, source_id, target_kind, target_id, relation)`, tenant-scoped, unique per (kind, id, kind, id, relation). Written by the intake flows:
  - `import_batch → import_batch_row`, `import_batch_row → account`, `import_batch_row → trial_balance`
  - `import_batch → source_document` (evidence)
  - `mapping_suggestion → tax_mapping` (applied), `mapping_suggestion → tax_memory_precedent`
  - `evidence_link → source_document`
- The **read API** (`GET /api/intake/lineage/*`) traverses both these persisted edges **and** the existing foreign keys (`tax_mappings.account_id`, `mapping_proposals.account_id`, `provision_runs.source_document_id` + `parent_run_id`, `review_items.*`, `external_filings.run_id`, `provision_results.run_id`) — so an account's full trace (import → mapping → rule → calculation → review → filing) is derivable today without touching existing write paths.
- Graph shape (nodes are existing/new domain records):

```text
source_document ──< import_batch ──< import_batch_row ──> account ──> tax_mapping
                      │                    │                           │
                      │              trial_balance               mapping_proposal
                      │                    │                           │
                      └──> evidence_links  └─> provision_run <─────────┘
                                                │
                                                ├─> provision_result
                                                ├─> review_item
                                                └─> external_filing
```

### 3.3 Evidence graph

- `evidence_links` — `(tenant_id, subject_kind, subject_id, document_id → source_documents, evidence_role, note, created_by_user_id)`. Subjects: `import_batch`, `import_batch_row`, `account`, `tax_mapping`, `mapping_proposal`, `tax_adjustment`, `provision_run`, `review_item`.
- Evidence upload/download reuse the existing documents module (versioned, checksummed, storage backend). Attaching a document to a review item marks the item's `document_id` too.
- **Evidence gates:** (a) a batch with error rows cannot be committed; (b) batches whose control totals do not balance within tolerance get a `control_total_imbalance` review item; (c) asset accounts without placed-in-service metadata get an evidence-request review item (`evidence_requested`). These are deterministic gates, not AI judgements.

### 3.4 Tax memory + learning

- `tax_memory_precedents` — approved mapping precedent keyed by `tenant_id`, optional `entity_id`/`group_id` scope, `jurisdiction`, `effective_from/to`, plus the account signature (`account_name`, `account_number`, `account_type`, `detail_type`) and the approved treatment (`tax_account_type`, `book_treatment`, `timing_category`). Source mapping FK (`source_mapping_id → tax_mappings`) ties the precedent to the versioned mapping it came from.
- `mapping_suggestions` — a suggestion made during intake: scope (`entity_id`, `period`), the suggested treatment, `confidence_score`, `source` (`tax_memory | precedent | ai | rules | fallback`), `cited_precedent_id`, `rationale` (explains **why** this precedent was selected), `status` (`pending | accepted | rejected | overridden | applied`), decision fields.
- `reviewer_feedback_events` — the learning event log: `feedback_type` (`accepted | rejected | overridden | corrected`), subject kind/id, `suggested` vs `applied` snapshots, `reason`, `user_id`.
- **Scoring is deterministic.** A precedent is suggested only when: tenant matches, jurisdiction matches, scope is compatible (entity match preferred, then group, then tenant-wide), effective period overlaps the batch period, and normalized account-name similarity ≥ 0.5. Confidence is derived from scope + similarity + precedent vintage. No opaque model training in this phase.
- **Never silently reuse:** suggestions are only ever *proposals* on reviewable rows; commit applies only `accepted` suggestions, and only with the reviewer's explicit decision recorded.

### 3.5 Manual adjustments

- `tax_adjustments` — `(tenant_id, provision_run_id, account_id, adjustment_type, amount, description, reason REQUIRED, evidence_document_id, created_by_user_id, version, supersedes_adjustment_id)`. Adjustments are recorded, versioned and evidence-linked; a locked run still cannot be recalculated — adjustments belong to the governed trail and are consumed by a later calculation phase (out of scope here to keep the deterministic engine untouched).

## 4. API surface (new module `modules/intake`)

| Route | Purpose |
|---|---|
| `POST /api/intake/batches` | multipart upload → store versioned source document, create batch (draft) → parse + validate → `ready_for_review` or `failed`; idempotent on (file, entity, period, source) |
| `GET /api/intake/batches` | intake queue (status/entity/source filters) |
| `GET /api/intake/batches/:id` | batch detail (control totals, validation summary, source document, events) |
| `GET /api/intake/batches/:id/rows` | row-level review data (raw, normalized, errors, suggestions) |
| `POST /api/intake/batches/:id/validate` | re-run validation explicitly (`validating → ready_for_review`) |
| `POST /api/intake/batches/:id/commit` | gate-checked commit: writes accounts + trial balance, applies accepted suggestions as versioned mappings, records events/lineage, supersedes prior batch |
| `POST /api/intake/batches/:id/fail` | mark failed with reason (only draft/validating) |
| `POST /api/intake/batches/:id/evidence` | attach evidence document to the batch |
| `POST /api/intake/evidence-links` | attach evidence to any supported subject |
| `GET /api/intake/evidence-links?subjectKind&subjectId` | list evidence for a subject |
| `DELETE /api/intake/evidence-links/:id` | remove (blocked for committed/locked subjects) |
| `POST /api/intake/batches/:id/suggestions/generate` | surface tax-memory / precedent / AI suggestions for batch rows (low confidence → review items) |
| `POST /api/intake/suggestions/:id/decide` | accept / reject / override with reason → feedback event + suggestion status + classification pattern + memory update |
| `GET /api/intake/memory/precedents` | explainable precedent query |
| `GET /api/intake/lineage/account/:accountId` | account lineage (imports → mappings → runs → reviews → filings) |
| `GET /api/intake/lineage/run/:runId` | run lineage (upstream evidence/mappings + downstream reviews/filings) |
| `GET /api/intake/metrics` | acceptance rate, override rate, exception rate, time-to-review |

## 5. Bounded AI agents (reused `eve/` architecture)

All intake agents run through the existing trace store (`ai_runs`/`ai_steps`), produce zod-validated JSON with confidence + reasoning + source references, and never make tax decisions:

- **document parser** — deterministic RFC-4180 CSV parser (quoted fields, escaped quotes, embedded newlines, BOM); PDF/XLSX parsing remains the existing Interfaze endpoint.
- **account classification/mapping agent** — existing mapping agent + `precedent-engine`; surfaced here as suggestions with citations.
- **reconciliation agent** — deterministic debit/credit/control-total reconciliation; an optional AI summary is generated only when a provider is configured and is persisted as a trace.
- **evidence-gap agent** — deterministic scan producing `evidence_required` review items.
- **review-summary agent** — AI summary of batch validation for the reviewer (fallback to deterministic text when no provider key is configured).

## 6. Deterministic controls on the calculation path

- `provision_runs` gains `rule_version_hash` (migration adds the column; the workbench calculation populates it with a stable hash of `rules_used`) — alongside the existing `input_data_hash` and `mapping_version_hash`, outputs are reproducible from stored inputs.
- Finalized/locked runs remain immutable (existing 409 gates); recalculations are new run versions via `parent_run_id`. Manual adjustments are recorded with reason/user/timestamp/evidence (3.5).

## 7. Migration path & rollback

- Migration `0017_enterprise_intake.sql` is additive only: new tables + `rule_version_hash` column + indexes + RLS policies + grants. No existing column or constraint is altered.
- Rollback: `DROP TABLE` the seven new tables (children first), drop `rule_version_hash`, drop indexes; remove journal entry `0017_enterprise_intake`.
- The old ad-hoc CSV endpoint (`POST /api/import/trial-balance`) is preserved unchanged — the intake module is the new canonical path; the workbench import remains for run-scoped imports.
