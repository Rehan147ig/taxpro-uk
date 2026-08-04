# @taxpro/tax-engine-enterprise

> UNVALIDATED — built from public reference material only, not reviewed by a
> CPA, tax attorney, or real ERP export. Every heuristic and assumption below
> is a guess to be corrected by a domain expert or real data, not a claim of
> correctness.

Exploratory, isolated package for multi-entity / group / GL-ingestion tax
workflows. Built from public reference material only — no CPA review, no real
ERP export, no live HMRC gateway, no RAG/vector-DB ingestion.

**Isolation contract:** no file in `apps/api`, `apps/web`, or
`packages/tax-engine` imports this package's computation engine, and it is not
wired into any route, UI, engine factory, or jurisdiction resolver.

## Contents

| Module | What it is |
|--------|------------|
| `src/model/entity-groups.ts` | Drizzle schema: `entity_groups`, `entity_group_members`; type-level link to the existing single-entity provision output shape (`ProvisionSummary` from `@taxpro/tax-engine`) |
| `src/model/gl-transactions.ts` | Drizzle schema: `general_ledger_transactions` staging table |
| `src/uk/group-relief.ts` | Pure UK group relief calculator (CTA 2010 Part 5) with elimination trail and explicit non-handled gaps (consortium relief, non-coterminous periods, carried-forward losses) |
| `src/elt/heuristics.ts` | Deterministic regex flagging of GL narration → findings; every pattern marked as a guessed pattern |
| `src/elt/adapters.ts` | Interface shapes only for NetSuite / Xero / QuickBooks exports + pure normalizers; no live API code |
| `src/elt/pipeline.ts` | Chunked ELT pipeline (default 5,000 rows/chunk) with skip/report, heuristics, optional load sink |
| `ASSUMPTIONS.md` | Every assumption (regexes, heuristics, group-relief rules) with what would confirm or break it |

## Scripts

- `npm run build` — tsc to `dist/` (plain build; deliberately NOT a `tsc --build`
  project-reference target, keeping the package isolated)
- `npm run lint` — `tsc --noEmit` over source and tests
- `npm run test` — vitest

## Status

UK group relief (CTA 2010 Part 5) and GL-ingestion ELT are covered by unit
tests; build + lint PASS. Everything remains exploratory and UNVALIDATED:
before any production use of the computation engine, review with a CPA / tax
attorney, validate regexes against a real ERP export, and replace the
UNVALIDATED banner.
