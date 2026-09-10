# TaxPro UK — Pilot Onboarding Runbook

**Audience:** pilot accounting firms (partners, reviewers, preparers).
**Product:** UK FRS 102 Section 29 corporate tax provision workbench — AI prepares,
deterministic engine calculates, humans approve.
**Honesty contract (see `docs/UK_NON_GOALS.md`):** TaxPro is a preparation and
review workbench. It never submits to HMRC; final statutory sign-off remains
with the firm's qualified signing partner.

---

## 1. System prerequisites

| Requirement | Detail |
|---|---|
| Browser | Current Chrome or Edge. No plugins required. |
| Access | Firm workspace URL + named logins (see §3). MFA per firm policy. |
| Trial balance | CSV export from the client ledger (Xero/QBO/Sage): account code, account name, debit, credit, period. Template under Data Sources → Universal GL Import. |
| Xero (optional) | An OAuth connection per client organisation (Data Sources → Xero). Needed for one-click import and DRAFT journal push. |
| Periods | 12-month accounting period plus matching tax period (Periods page). Non-standard periods are supported but raise a review item (§5). |

## 2. Step-by-step pilot walkthrough

Reference demo tenant: use the Dashboard scenario loaders (**Marginal Relief**,
**R&D Loss**, **Capital Allowances**) for a guided first run before live data.

### Step 1 — Ingest data
1. **Data Sources → Universal GL Import**: paste or upload the client TB CSV, or **Sync Now** on a connected Xero organisation.
2. Confirm entity, currency GBP, and `taxJurisdiction = UK_FRS102`.
3. **Periods**: create/select the FY accounting period and linked tax period.

Expected: rows import with per-row source lineage; duplicates are idempotent
(checksum + `import_batch_id` linkage on the run).

### Step 2 — Review AI classifications
1. **Tax Mapping**: work the queue top-down — `missing_mapping` (high) first, then `low_confidence_mapping` (< 75%).
2. Approve, reject, or override each suggestion. Overrides require a reason and are versioned.
3. **Proposals & Rules**: decide pending mapping proposals; confirm the UK rule versions in force (CTA 2010, CAA 2001, FRS 102 s29).

Tooltips throughout define **CTA 2010 s.18D Marginal Relief**,
**FRS 102 Section 29 Timing Differences**, and **HMRC Tax Band Alignment**.

### Step 3 — Run the Workbench provision
1. **Workbench**: select entity → accounting period → tax period → source document → **Run**.
2. The engine calculates current tax (19% / marginal relief / 25%), deferred tax
   (no discounting, s29.17), and the ETR walk deterministically.
3. Clear every flagged review item:
   - *Missing depreciation dates* → enter the placed-in-service date (§5.1).
   - *Non-standard periods* → confirm or split (§5.2).
   - *Marginal relief overrides* → confirm associated-company count (§5.3).
4. **Finalize** only enables at zero open items (open, in-progress, and
   waiting-for-evidence all block).

### Step 4 — Partner sign-off & lock
1. **Reviewer** submits for approval → **Partner** (a different person)
   approves. Self-approval is refused (403), as is approval by the preparer
   when maker-checker is enabled.
2. **Partner locks** the run. Lock requires an approved run and clean
   workbench gates. Locked runs are immutable (409 on any mutation attempt);
   unlocking is refused once an external filing is recorded.
3. Billing note: the single billable usage event is recorded at finalize/lock,
   priced from the plan in force — failed, rejected, or abandoned runs are
   never billed.

### Step 5 — Export workpapers
1. From a locked run: **Export Workpapers (.xlsx)**, **Audit ZIP Package**
   (byte-identical, SHA-256 manifest), **CT600 figures**, **iXBRL instance/inline**.
2. Optional: **Push to Xero** posts the journals as a **DRAFT** manual journal
   (explicit account-code mapping, partner/admin only). Authorise inside Xero.
3. Record the external filing (provider, reference, submitted date, manifest
   checksum) so the run reads `filed_externally` with an honest audit note.

## 3. User roles matrix

| Role | Run/calculate | Review items | Submit | Approve | Lock/unlock | Billing/admin | Xero push | Export |
|---|---|---|---|---|---|---|---|---|
| `admin` | ✓ | ✓ | ✓ | ✓ (not own) | ✓ | ✓ | ✓ | ✓ |
| `partner` | ✓ | ✓ | ✓ | ✓ (not own) | ✓ | — | ✓ | ✓ |
| `reviewer` | ✓ | ✓ | ✓ | — | — | — | — | ✓ |
| `preparer` | ✓ | ✓ | — | — | — | — | — | ✓ |
| `auditor` | — | read | — | — | — | — | — | approved/locked only |
| `client_readonly` | — | read | — | — | — | — | — | approved/locked only |

Cross-tenant access is denied at the API (403/404) and the database
(RLS, fail-closed) layers; verified by `npm run test:security -w @taxpro/api`.

## 4. Demo scenarios (training)

| Scenario (Dashboard → load) | Teaches |
|---|---|
| Apex Manufacturing — marginal relief | £150k profits → £1,500 relief → £36k charge; ETR relief line |
| BioTech Innovations — R&D loss | Nil charge; DTA only on evidenced timing (£13,750), never on the headline loss |
| Cotswold Logistics — capital allowances | CAA 2001 pool WDAs vs book depreciation; missing-date review item |

Reset a scenario any time (`POST /api/demo/switch-scenario` with `reset: true`);
resets are refused while provision runs reference the entity.

## 5. Exception handling guide

### 5.1 Missing depreciation / placed-in-service dates
Symptom: `missing_depreciation_metadata` review item on a fixed-asset account.
Fix: open the trial-balance detail, enter the placed-in-service date (or asset
age). Until evidenced, the engine applies main-pool WDA rates and flags the
account — it never assumes 100% first-year relief. UK-specific: confirm AIA /
full-expensing eligibility before claiming first-year treatment.

### 5.2 Non-standard periods
Symptom: `fiscal_year_straddling` warning. The run discloses the fiscal-year
day split (e.g. FY2023: 91d, FY2024: 275d) and applies the period-end FY rate.
Fix: confirm the split on screen; for short (< 12-month) periods, profit limits
are time-apportioned automatically.

### 5.3 Marginal relief overrides
Symptom: reviewer questions the relief line. Fix: confirm the associated-company
count (limits divide per CTA 2010 s.18D) and that profits sit in £50k–£250k.
The ETR walk shows the relief as an explicit negative line; outside the band it
is legitimately zero.

### 5.4 Blocked runs and gates
The Workbench lists open gates (evidence, proposals, periods) with codes and
messages. Clear them in order; gates re-evaluate on every run — recalculation
creates a new version and never mutates a locked run.

## 6. Support & SLA escalation

| Severity | Example | Response | Channel |
|---|---|---|---|
| P1 — close blocked | Provision/run or export down in close season | 4 business hours | Pilot hotline + shared Slack |
| P2 — wrong figures | Suspected engine miscalculation | 1 business day, workaround + fixture | Support desk; attach run ID + manifest SHA |
| P3 — UX/query | Mapping, permissions, onboarding | 2 business days | Support desk |

Every report should include: tenant, entity, period, run ID, and (for figure
queries) the manifest SHA-256 so support reproduces the exact deterministic
package. Suspected miscalculations become regression fixtures in
`packages/tax-engine` before the fix ships.
