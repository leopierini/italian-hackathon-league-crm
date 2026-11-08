# PRD: Brambilla CRM

Written at the start of the Italian Hackathon League final (9 October 2026), before the build.
It records the product decisions and the working plan. Scope is limited to the organizers' brief.

## Problem

Brambilla Forniture must replace its aging Sinergia CRM without losing its 15-year customer,
deal, support, and activity history, and needs a usable CRM tomorrow.

## Judge contract

Implement the API contract from the brief: bearer auth on every route except
`GET /health`; `POST /__reset` returns `204`; `POST /__migrate` imports the archive from
`export_url` and returns `204` only when complete; `POST /__agente` accepts the full
conversation and replies in Italian as `{"reply":"..."}`.

The migration must finish inside 5 minutes. Ordinary calls have 10 seconds, assistant turns 60
seconds. The hidden migration uses another export with the same schema and size. Score allocation:
50 points R1-R12, 30 assistant, 10 API conformity, 10 durability. The suite runs once after the
15:30 freeze.

## Scenarios

| Request | Input | Expected behavior |
|---|---|---|
| R1 Companies | Sinergia companies CSV | Import non-deleted companies; merge duplicates by website; retain other sites in `hs_additional_domains`; map legal name, domain, city, province, and `id_legacy`. |
| R2 People | Contacts CSV | Normalize lifecycle stage; treat invalid email as absent; merge duplicate people by email; associate each contact with its company where available. |
| R3 Deals | Opportunities, line items, users | Map amount/currency, pipeline/stage, close date, current owner, and unique company/contact associations. Deal value comes from offer lines when present; renewals are annual. |
| R4 Products and quotes | Price list and offer-line CSVs | Create products and line items with product/deal links, quantity, euro price, discount, and rounded line total; omit lines whose deal is not imported. |
| R5 Support | Ticket CSV | Import tickets into the `Assistenza` pipeline with mapped stage, priority, dates, current assignee, and valid company/contact associations. |
| R6 History | Activity CSV | Map activities to notes, calls, emails, or meetings with timestamp, text, author, and contact/deal associations. |
| R7 VAT number | Company notes and API writes | Extract valid 11-digit VAT numbers into unique `partita_iva`; reject a create that reuses an existing value with `409`. |
| R8 2025 revenue and class | Imported deals and associations | Sum 2025 won revenue, including renewals and same-year storni, convert USD/GBP at the fixed rates, round to cents, then assign class A/B/C or blank. |
| R9 Dormant customers | Imported wins and activities | Create `Clienti dormienti` containing companies with a win in any year and no activity in 2025 from their contacts or deals. |
| R10 Won deal follow-up | Deal created or moved to `Vinta` in sales | Create exactly one linked `Assistenza` ticket in `Aperto`, assigned to the deal's `commerciale`, linked to its companies. |
| R11 Lost deal callback | Deal created or moved to `Persa` in sales | Create exactly one linked task due 180 days after entry, with `NOT_STARTED` status. |
| R12 Contact-company association | Contact create/import without company | If its email domain matches an existing company's domain, associate it; do not create companies or overwrite an existing association. |
| R13 Assistant | Italian messages, user/time context, optional CSV attachments | Read and write through CRM rules; answer truthfully in Italian; ask for needed details or decline unsafe/ambiguous actions; change only intended records. |

General import rule: deleted records are omitted. Duplicates keep the most recently modified
record's legacy ID, and each field takes the latest non-empty value. Broken references behave as
empty; references to merged records point to the surviving record. Exact property, pipeline, and
stage names come from the client's requests document (organizer material, not redistributed).

## Scope

### In

- The authenticated CRM API required by the brief, including health, reset, migration, core
  objects, associations, search, and the linked HubSpot conformity modules.
- Reliable import of the provided and hidden Sinergia exports, including deduplication and
  Brambilla's data rules R1-R9.
- CRM behavior R10-R12 and the Italian assistant R13, with changes constrained to intended
  records.
- English UI routes for company details, deals board, dormant customers, and support tickets.
- A local harness that replays the available examples and checks the documented API behavior.

### Out

- Any feature not in the brief or needed for its API, migration, assistant, or jury UI.
- Any AI feature inside the CRM other than the assistant using the specified model.
- HubSpot branding.
- UI polish before the local migration/API scenarios work.

## UI for the human jury

Built in `crm/web`. English. Four jury
pages, listed in `/health` `ui`: the company page leads with 2025 revenue and customer class,
then contacts, deals and history; the deals board by stage (Vendite and Rinnovi); the
`Clienti dormienti` list; the tickets. The assistant is a chat panel inside the CRM. Memorable
detail: the Sinergia legacy ID beside imported records, so the migration can be checked against
its source.

## Plan

| By | Milestone | Points it unlocks |
|---|---|---|
| 11:30 | `crm/` skeleton deployed on Railway with Postgres: `/health`, 401, `/__reset`, `/__migrate` stub, `/__agente` stub. URL registered, first form check run. | the gate for everything |
| 12:45 | Migration R1-R9 on the provided export, timed on Railway under 2.5 min. Form check green on migrate. | 40 + durability 10 |
| 13:45 | Objects, search, associations, properties, pipelines and lists API; R7 409, R10, R11, R12. | conformity 10 + R10-R12 10 |
| 14:30 | Assistant on `/__agente` with CRM tools, same rules as the API; a few real model calls only. | 30 |
| 15:00 | Jury UI: the four pages. | jury, top 6 only |
| 15:00-15:30 | Fixes only. Choice sheet on the platform from `docs/choices.md`. Last form check before 15:20. | jury |

If a milestone slips by more than 20 minutes, cut scope from the next one, not from migration.

## Risks

- 676k source rows and inconsistent encodings, deleted flags, duplicate records, dates, amounts,
  statuses, and stages can cause silent data loss. Initial profiling is in
  [sinergia-export-profile.md](sinergia-export-profile.md); it is not an exhaustive case list.
- Migration has a hard 5-minute limit; Railway timing varies between runs. Measure on the deploy.
- The CRM must remain correct after restart and handle parallel creates, updates, upserts, search,
  and reads under load.
- The assistant has only $10 of model spend for development and evaluation, plus a 30-minute
  evaluation cap. Limit exploratory model calls and scope writes carefully.
- After 15:30, a broken or missing deploy cannot be repaired until evaluation ends.
