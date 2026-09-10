# TaxPro UK — Pilot Partner Agreement (Template)

**Status:** template for legal review — not executed advice.
**Companion:** `docs/PILOT_ONBOARDING_RUNBOOK.md` (operations),
`docs/UK_NON_GOALS.md` (scope contract).

---

## 1. Parties and purpose

This Pilot Agreement is between **TaxPro** and the **Firm** named in the
signature block. Its purpose is a bounded evaluation of TaxPro as a UK
FRS 102 Section 29 provision preparation and review workbench, with success
measured on historical engagements before any production reliance.

## 2. Scope — what TaxPro is and is not

- TaxPro **is**: AI-prepared mappings and memos, a deterministic UK tax engine,
  reviewer workflow with maker-checker sign-off, locked-run immutability, and
  deterministic evidence packages (workbook, CT600 figures, iXBRL, audit ZIP).
- TaxPro **is not**: a filer. It never submits to HMRC or Companies House.
  **Final statutory sign-off remains at all times with the Firm's qualified
  signing partner**, who must review every figure before filing through the
  Firm's existing recognised software.
- Out of scope (see `docs/UK_NON_GOALS.md`): VAT MTD, international tax,
  autonomous computation, US ASC 740 workstreams, secretarial filings.

## 3. "Shadow close" protocol

1. The Firm selects **10–20 completed historical year-ends** spanning the
   provision patterns it sees: standard 25% cases, sub-£50k profits, marginal
   relief band (£50k–£250k), trading losses with deferred tax assets, and
   heavy capital-allowance clients.
2. Each engagement is re-run in TaxPro **in parallel** with the Firm's
   existing software. Both outputs are recorded; differences are triaged
   jointly as (a) TaxPro defect → regression fixture, (b) mapping/input
   difference → onboarding fix, or (c) judgement call → documented position.
3. **Exit criteria for paid conversion:** ≥ 90% of shadow engagements agree
   within the Firm's materiality threshold, all differences in (a) fixed and
   re-verified, partner sign-off recorded on the shadow report.

## 4. Data protection & GDPR

- **UK data residency:** pilot data is hosted in the UK region stated in the
  order form. No client data leaves the UK without written consent.
- **Encryption:** TLS in transit; AES-256-GCM token encryption at rest
  (`TOKEN_ENCRYPTION_KEY` under firm-controlled KMS rotation schedule);
  database encryption per the production readiness report.
- **Tenant isolation:** strict row-level security (fail-closed without tenant
  context), NOBYPASSRLS runtime role, append-only audit and filing ledgers.
  Evidence: `npm run test:security -w @taxpro/api` (adversarial suite) and the
  RLS assertions in CI, re-runnable by the Firm on request.
- **Retention & return:** on termination, Firm data is exported (trial
  balances, mappings, locked-run evidence packages) and then deleted within
  30 days, with written confirmation. Backups age out within 90 days.
- **Sub-processors:** hosting, error reporting, and (if enabled) the firm's
  Xero organisation connection. Listed in the order form; changes notified
  30 days in advance.

## 5. Commercial pilot terms

- **Evaluation:** free for the shadow-close set (up to 10 historical returns),
  including onboarding support per the runbook SLA.
- **Paid pilot:** on meeting the exit criteria, preferred pricing of
  **£65 per provision** (finalize/lock billable event) for the next
  **50 year-ends**, billed from immutable usage events. Failed, rejected, or
  abandoned runs are never billed. Over-quota and renewal pricing in the
  order form.
- **Term & exit:** 6-month pilot term, terminable with 30 days' notice. No
  lock-in on data (§4); run history exports remain readable without a licence.

## 6. Warranties, liability, and signatures

- TaxPro warrants the deterministic behaviours covered by its test suites and
  schema harness; AI outputs are advisory and carry no correctness warranty.
- Liability is capped at fees paid under this pilot (or £10,000 if no fees
  yet paid), excluding data-protection breaches and wilful misconduct.
- Neither party discloses the other's client data or commercial terms.

| | TaxPro | Firm |
|---|---|---|
| Signed | | |
| Name / title | | |
| Date | | |
| Order form ref | | |
