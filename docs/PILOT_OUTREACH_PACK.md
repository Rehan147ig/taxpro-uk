# TaxPro UK — Pilot Outreach Pack (send-ready)

**Status:** working sales collateral — pair with `docs/PILOT_PARTNER_AGREEMENT.md`
(terms) and `docs/PILOT_ONBOARDING_RUNBOOK.md` (operations).
**Rule of the pack:** every claim below is either demo-provable in 15 minutes
or explicitly labelled as pilot-gated. Never claim production, filing-ready,
or HMRC submission — the product does none of those.

---

## 1. Target ICP directory

**Firm profile (UK regional mid-tier, ranks ~15–100 + strong independents):**
50–2,500 staff, SME/mid-market client base, FRS 102 corporation-tax provision
done in-house every year-end, feeling the capacity crunch (industry reporting:
~73% of practices recently turned away work for lack of staff).

**Where to find them:**
- Accountancy Age Top 50+50 and Business & Accountancy Daily Top 75 league
  tables (firm names, fee income, headcount, office footprint).
- ICAEW regional faculties and events; AccountingWEB community.
- Xero App Store (firms already on Xero — we integrate).
- PE-backed consolidator groups standardising tooling across practices
  (approach after 1–2 independent pilots, not before).

**Personas (all three at each target firm):**

| Persona | Cares about | Your hook |
|---|---|---|
| **Tax Partner** (signs) | Throughput in crunch, defensibility, risk | Shadow-close proof on *their* files; partner-only sign-off |
| **Head of Corporate Tax** (uses) | Review bottlenecks, junior output quality | Remembered maps, specific review items instead of rework |
| **Digital Innovation Partner** (unlocks) | Tooling standardization, data control | Tenant isolation, audit trail, Xero-native flow |

Target: 10–15 firms contacted → 3 pilots. That is the entire Year 1 funnel.

---

## 2. Sequence A — LinkedIn InMail ("Shadow-Close Challenge")

**Touch 1 — cold (under 100 words):**
> Subject: your 10 messiest year-ends, re-run in parallel?
>
> [Name] — we built a UK FRS 102 provision workbench that eats real firm
> exports (offset Excel headers, flipped signs, renamed accounts) and turns
> each anomaly into a specific review item instead of a silent wrong number.
> Proposal: a free 10-return shadow close on *completed* historical year-ends
> — we run alongside your existing software, differences triaged jointly.
> 15-minute live demo on your ugliest trial balance? No deck, just the file.

**Touch 2 — follow-up, day 4 (proof, not pressure):**
> Quick proof point while you think: our engine reconciles 9 real Companies
> House filings (Tesco, Greggs, Vodafone…) at a mean 1.3bp ETR delta, and
> every number carries its evidence trail. The shadow close is free and
> bounded — worst case you get a second opinion on 10 files.

**Touch 3 — breakup, day 11 (leave the door open):**
> Closing the loop — if year-end bandwidth frees up (or January gets rough),
> the offer stands: 10 historical returns, parallel run, joint triage. One
> reply restarts it.

---

## 3. Sequence B — Cold Email ("Marginal Relief & January Close Fatigue")

> Subject: marginal relief + January capacity
>
> [Name],
>
> Two facts: (1) the CTA 2010 s.18D marginal-relief band (£50k–£250k) is where
> spreadsheet provisions most often drift a few basis points unnoticed; (2)
> most practices are turning away work for lack of staff this cycle.
>
> TaxPro is a reviewer-approved UK provision workbench: deterministic FRS 102
> engine (9 real filings at 1.3bp mean ETR delta — Tesco, Greggs, Vodafone,
> Costa, Farmfoods), AI that *prepares* mappings but never decides, partner
> sign-off with maker-checker, locked immutable runs, and a filing-ready
> evidence package. It never files — your partner still signs everything.
>
> The ask: a free 10-return shadow close on completed year-ends, then (if the
> numbers agree) 50 live returns at £60/provision pilot pricing.
>
> 15 minutes this week? Bring your ugliest Excel TB — headers on row 3,
> revenue flipped, renamed accounts. That's the demo.
>
> [Name] · [phone] · [calendly]

---

## 4. The 15-minute Live Demo Script (Apex Marginal Relief scenario)

Setup before the call: demo tenant loaded, Apex Manufacturing Ltd scenario
selected (£150k taxable profits, s.18D band). Their file ready if they sent
one; otherwise the fixture `tb-offset-headers.xlsx`.

| Min | Beat | Talking track |
|---|---|---|
| 0–2 | Frame | "Not a tax engine pitch — a *review* pitch. AI prepares, deterministic rules calculate, your partner approves. Nothing files anywhere." |
| 2–5 | Messy ingest | Upload their Excel (or fixture): junk sheet ignored, headers found on row 3, columns mapped once and remembered. "This is the file that breaks every importer." |
| 5–8 | Sign + bridge | Show the sign-convention table and bridge diff. "Flipped signs and renamed accounts become named review items — never silent numbers." |
| 8–11 | Marginal relief run | Run Apex workbench: £150k taxable → £1,500 relief → £36k charge, ETR walk with the explicit marginal-relief line. "Check this against your filed computation." |
| 11–13 | Governance | Pending proposal → approve → submit → partner sign-off → lock → 409 on mutation → handoff ZIP with manifest hash. "Maker-checker is enforced, not requested." |
| 13–15 | Ask | "Send 10 completed year-ends; we shadow-close free, triage differences jointly, convert 50 live at £60/provision if ≥90% agree within your materiality." |

If anything errors live: narrate it ("review item, not a crash — that's the product working") and keep moving.

---

## 5. Objection Handling Cheatsheet

**"Is it AI?"**
> "Partially — and fenced. AI proposes mappings and drafts memos; every
> output is schema-validated and a failed AI call degrades to the
> deterministic path, never corrupts a number. The engine that computes your
> charge is pure audited math, and a human approves every mapping. Ask to see
> the fallback happen live."

**"Does it file to HMRC?"**
> "No — deliberately. TaxPro produces validated figures, CT600/iXBRL
> artefacts, and an evidence package; your firm files through its existing
> recognised software, and your signing partner signs every figure. Anyone
> promising one-click HMRC filing from a provision tool is selling risk."

**"Who has liability?"**
> "Your signing partner — same as today, stated plainly in the pilot
> agreement (ICAEW competence and due care). TaxPro warrants its tested
> deterministic behaviours; AI output is advisory with no correctness
> warranty; liability caps at pilot fees. The product's job is to make the
> partner's review faster and better-evidenced, not to replace it."

**"Our data in your cloud?"**
> "UK-hosted, tenant-isolated at the database layer (fail-closed), encrypted
> in transit and at rest, export-and-delete within 30 days on exit. Happy to
> walk your IT through the readiness report."

**"We're fine with spreadsheets."**
> "For standard 25% cases, probably. The pain is the s.18D band, loss/DTAs,
> and January throughput — that's the 10-file shadow close: free, parallel,
> no workflow change. Keep the spreadsheets; let us race them."

---

## 6. Pilot conversion checklist (for us, not the firm)

- [ ] 10 shadow returns selected across bands (standard / sub-£50k / s.18D / loss-DTA / heavy allowances)
- [ ] ≥90% agree within firm materiality; all TaxPro defects fixed + re-verified
- [ ] Partner sign-off on the shadow report (recorded, with reasons)
- [ ] Agreement signed → 50 live at £60/provision → onboarding per runbook
- [ ] Case study permission (hours saved, items caught) → unlocks firms 2–10
