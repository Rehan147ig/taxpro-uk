# ASSUMPTIONS — @taxpro/tax-engine-enterprise

> UNVALIDATED — built from public reference material only, not reviewed by a
> CPA, tax attorney, or real ERP export. Every heuristic and assumption below
> is a guess to be corrected by a domain expert or real data, not a claim of
> correctness.

Every item below is a working assumption of this exploratory package. Each row
states (a) what the code assumes and (b) the single most useful thing that
would confirm or break that assumption.

## 1. Multi-entity data model (`src/model/entity-groups.ts`)

| # | Assumption | Would confirm | Would break |
|---|------------|---------------|-------------|
| 1.1 | `domicile` is a simple `'UK'` routing code; real tax residence is a legal determination outside this model | A domain expert maps legal residence (e.g. place of effective management) to this code | Any requirement to model non-UK residence, dual residence, or branches |
| 1.2 | A group has exactly one parent; `role` is `'parent'` or `'subsidiary'` | Real group structures are single-parent trees | Holdings with co-parents, partnerships, or transparent entities in the tree |
| 1.3 | `ownership_percentage` is numeric 0–100 and is NOT used to derive relief entitlements | Group relief eligibility (UK: 75% subsidiary/51% group tests) is checked outside this package | Any rule that derives relief eligibility from this column alone |
| 1.4 | `entity_id`, `trial_balance_id`, `provision_id` are logical UUID references to host-app tables | The host app owns those tables and supplies ids | The host app changes its id scheme or these tables move outside its ownership |
| 1.5 | The standalone single-entity provision output shape is `ProvisionSummary` from `@taxpro/tax-engine` (reused by type import, not duplicated) | `@taxpro/tax-engine` keeps its public shape stable | `ProvisionSummary` changes shape; then this package's type import must be updated |

## 2. UK group relief (`src/uk/group-relief.ts`, CTA 2010 Part 5)

| # | Assumption | Would confirm | Would break |
|---|------------|---------------|-------------|
| 2.1 | Surrender is capped at the claimant's taxable profit for the period | HMRC/CTA reading confirms relief limited to claimant's profits | A special rule (e.g. non-trading profits restrictions) increasing or reducing the cap |
| 2.2 | Only current-period trading losses are surrendered; sign = negative profit | Real data shows losses arriving as negative taxable profit | Losses arrive in a separate field, or capital losses/mgmt expenses are surrendered |
| 2.3 | Claimants and surrenderers are processed in input order (greedy, no sorting) | A reviewer accepts input order for allocation | Allocation must follow a statutory priority or optimal packing |
| 2.4 | All amounts rounded to 2dp (GBP pence) | HMRC accepts 2dp rounding for relief amounts | Rounding must be per-step with different rules (e.g. truncation) |
| 2.5 | Consortium relief is NOT implemented | A group has no consortium members | Any consortium member appears in the group model (results would be wrong) |
| 2.6 | Non-coterminous accounting periods are NOT implemented | Every member shares one accounting period | Members have mismatched periods (surrender must be apportioned) |
| 2.7 | Carried-forward losses / post-2017 reform (group £5m allowance, 50% relevant-profits cap) are NOT implemented | The calculator is only fed current-period losses | Group relief claims for carried-forward losses are attempted |
| 2.8 | The statutory claim window (commonly stated as two years after period end) is not enforced | Deadline checks live in the host app | Deadline is expected in the calculator itself |
| 2.9 | Group-membership eligibility tests (75% subsidiary etc.) are outside this function | Eligibility is verified before the calculator runs | Eligibility must be recomputed inside the function |

## 4. GL heuristics (`src/elt/heuristics.ts`)

| # | Pattern (regex, case-insensitive) | Assumed rule | Would confirm | Would break |
|---|-----------------------------------|--------------|---------------|-------------|
| 4.1 | `\b(entertain(ment|ing)?\|client (meal\|lunch\|dinner)\|business meal\|happy hour\|bar tab\|booze\|golf (outing\|day)\|corporate event\|team outing\|wine tasting)\b` | Client/social entertainment is largely non-deductible (UK CTA 2009 s.1298 area) | A real export's entertainment narrations match; tax law reading confirms non-deductibility | Real exports phrase entertainment differently, or a client meal is deductible business travel |
| 4.2 | `\b(penalt\|late filing\|late payment\|interest penalty\|civil (fine\|penalty)\|citation\|speeding ticket\|parking ticket\|red light\|violation (fee\|charge\|fine)\|surcharge)\b` | Penalties/fines are generally non-deductible (CTA 2009 s.1303 area) | Real penalty narrations match and review flow catches deductible civil penalties | Narration vocabulary differs; deductible fines are common enough to need whitelisting |
| 4.3 | `\b(gift\|present\|thank you (gift\|card)\|holiday (gift\|card)\|gift basket\|gift card)\b` | Business gifts limited (CTA 2009 s.1298(4)(b) area) | Real gift narrations match; cap logic lives outside this package | Promotional marketing spend (deductible) is phrased with "gift" words and over-flagged |
| 4.4 | `\b(hotel\|lodging\|stay\|airbnb\|bed and breakfast\|bnb)\b` | Hotel/lodging is deductible business travel in many cases, review-only severity | Reviewers confirm lodgings are travel-related | Personal lodging appears regularly and needs a stronger flag |
| 4.5 | Empty/whitespace narration ⇒ `EMPTY_NARRATION` | Narration-less rows cannot be assessed | Real exports always carry narration (then this flag is dead code) | Real exports often lack narration (then flag volume explodes and needs dedup) |
| 4.6 | Non-empty `taxTagOverrides` ⇒ `TAX_TAG_OVERRIDE` review note | Human annotations override heuristics | Real annotation semantics match "human wins" | Overrides are machine-generated or stale (then the review note misleads) |
| 4.7 | All patterns are deterministic regex only | Determinism is required for testing/review audit | A reviewer accepts deterministic-only flagging | NLP/prediction is required for recall — then this module is only a baseline |

## 5. GL ELT pipeline (`src/elt/pipeline.ts`, `src/model/gl-transactions.ts`)

| # | Assumption | Would confirm | Would break |
|---|------------|---------------|-------------|
| 5.1 | Default chunk size is 5,000 rows | Measured memory/throughput on a real GL export supports it | Measured optimum differs (chunk size is a parameter) |
| 5.2 | `amount` is a signed amount, positive = debit / negative = credit | A real export provides signed amounts | Real exports use separate debit/credit columns (schema must change) |
| 5.3 | Amounts are 2dp `numeric(20,2)`; currency defaults to `GBP` | Real amounts/currency match | Multi-currency rows need exchange-rate staging (out of scope) |
| 5.4 | `transactionDate` is ISO `yyyy-mm-dd`, no timezone handling | Exports are date-only | Exports carry datetimes with zones needing normalization |
| 5.5 | Bad rows are skipped with a reason, pipeline continues | Operators want per-row resilience | Any malformed row should abort the whole run |
| 5.6 | `load` errors propagate and abort the pipeline | A failed DB insert must stop the run | Load should be retried or queued instead |
| 5.7 | `raw_payload` keeps the full original ERP row | Re-derivation from source is desired | Storage cost matters more than provenance (then drop the column) |
| 5.8 | Processing is sequential, chunks in order, deterministic | Determinism is a requirement | Parallel chunk processing is required (deterministic parallel needs care) |

## 6. ERP adapter shapes (`src/elt/adapters.ts`)

| # | Assumption | Would confirm | Would break |
|---|------------|---------------|-------------|
| 6.1 | NetSuite export fields: `trandate`, `account`, `memo`, `amount`, `currency` | A real NetSuite GL export matches these names | Real field names differ (e.g. `trandate` → `Date`, account as code) |
| 6.2 | Xero export fields: `Date`, `Account Code`, `Narration`, `Amount` | A real Xero export matches | Real exports vary by report/locale |
| 6.3 | QuickBooks export fields: `Txn Date`, `Account`, `Memo`, `Amount`, `Class` | A real QBO export matches | Real field names differ (e.g. `Date` vs `Txn Date`) |
| 6.4 | `tenantId` is not derivable from export rows and must be supplied by the caller | Host app supplies tenant context per run | Tenant id appears in the export (then normalizers could fill it) |
| 6.5 | Amounts tolerate thousands separators and empty values default to zero | Real exports contain such values | Real exports use locale formats (e.g. `1.234,56`) the comma-strip would corrupt |

## 7. Status of this package

| # | Item | Status |
|---|------|--------|
| 7.1 | Reviewed by a CPA, tax attorney, or against a real ERP export | NOT done — this is the single most important next step |
| 7.2 | Imported by apps/api or apps/web | Deliberately never — the package is isolated |
| 7.3 | Connects to HMRC or any ERP live gateway | No — interfaces only |
| 7.4 | Uses RAG/vector-DB legal ingestion | No |
| 7.5 | Tested | Unit-tested (vitest) against the assumptions above, which is not the same as validated |
