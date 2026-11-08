# Data choices

One block per case found in the Sinergia export. Counts are from the provided export (9 Oct 2026);
the code never uses them. A condensed version was submitted as the choice sheet.

The export belongs to the organizers, so the example rows below are synthetic stand-ins with the
same shape (invented names, `example.com`-style addresses, made-up IDs and VAT numbers). Counts and
formats are the real ones.

## Deleted marker

- **File/column:** `cancellato` in aziende, contatti, opportunita, listino, ticket, attivita.
- **Example:** `S`, `s`, `SI`, `Sì`, `1` vs empty, `0`, `N`, `NO`.
- **Count:** aziende 799 deleted of 20,497; contatti 2,802; opportunita 1,443; listino 70;
  ticket 671; attivita 10,713.
- **Rule:** yes-like markers (`s`, `si`, `sì`, `1`, `y`, `yes`, `true`, `x`, any case) mean deleted;
  everything else is kept. Deleted rows are dropped before duplicate detection, so they never
  merge with anything, and references to them become empty.
- **Verified:** unit test `deleted markers`; distribution measured per file.

## Owner of deals and tickets (`commerciale`, `assegnatario`)

- **File/column:** `utenti.csv` (`attivo`, `responsabile`), `opportunita.id_commerciale`,
  `ticket.id_utente`.
- **Example:** `U72;Anna;Esempio;anna.esempio@example.com;Commerciale;U07;NO` and
  `U80;Anna;Esempio;a.esempio@example.com;Commerciale;U04;SI`; deal ref `Rossi M.` or
  `BIANCHI DAVIDE` instead of a user id.
- **Count:** 85 users, 65 active. 6 people have an old inactive account and a new active one. Live deals: 24,703 active owner, 2,586 moved to
  the same person's active account, 5,632 moved to an active manager, 656 blank owner (stay
  empty). 125 deals reference the owner by name (`Nome Cognome`, `COGNOME NOME`, `N. Cognome`,
  `Cognome N.`); all resolve. Tickets: 16,369 active, 1,535 same person, 3,425 manager.
- **Rule:** "who follows it today". Resolve the reference (id, or full name in either order, or
  initial + surname). If the user is active, keep them. If inactive and the same person (same
  first and last name) has an active account, use that account. Otherwise walk `responsabile`
  up to the nearest active manager. If nobody is found, the field stays empty. Activity `autore`
  is history, so it keeps the original writer's email even if inactive.
- **Verified:** unit test with active, inactive with active manager, inactive chain, new-account
  twin, name references; full export: 0 unresolved references.

## Mojibake (UTF-8 text inside the Windows-1252 files)

- **File/column:** names and texts in aziende, contatti, ticket.
- **Example:** `MosÃ¨ Meccanica S.r.l.` (should be `Mosè Meccanica S.r.l.`), `conformitÃ`.
- **Count:** 1,322 values in aziende, 1,994 in contatti, 1,403 in ticket.
- **Rule:** a value with a UTF-8-as-cp1252 sequence (`Ã`, `Â`, `â€` + continuation) is
  re-encoded to cp1252 bytes and decoded as UTF-8; kept only if that decodes cleanly. A trailing
  `Ã` gets back the no-break space that trimming removed (`à` = C3 A0).
- **Verified:** after repair, 0 values in the export still contain such sequences.

## R1 duplicate companies: same website or same VAT

- **File/column:** `aziende.sito_web`, `aziende.note` (VAT), `ultima_modifica`.
- **Example:** `1003 Tessitura Bianchi S.p.A. tessiturabianchi.example.com P.IVA 09876543210` and
  `1004 Bianchi Tessuti bianchitessuti.example.com P.IVA 09876543210`, same city; and
  `1001 https://officinerossi.example.com` with `1002 www.officinerossi.example.com`.
- **Count:** 19,698 live rows -> 17,386 companies. 1,154 groups share a domain (after removing
  scheme, `www.`, path, case); 596 groups have different domains but the same VAT; 368 companies
  without a website merge with another through the VAT. 2,716 companies have no domain.
- **Rule:** two rows are the same company if they share the normalized domain or the VAT number
  (transitively). Same name is not used: the export has many different companies with the same
  name in different cities (one name appears on 20 different companies). The survivor keeps the `id_legacy` of the
  most recently modified row (`ultima_modifica`, ties by later row in the file); every field takes
  the value of the most recent row that filled it; `domain` is the most recent row's domain and the
  other distinct domains go to `hs_additional_domains` separated by `;`.
- **Verified:** 0 companies share a domain (primary or additional), 0 share a VAT, 0 domains
  contain `http`, `www.` or `/`; spot check: a merged company keeps the id of its newest row and
  the VAT from an older row.

## R7 VAT number from company notes

- **File/column:** `aziende.note`.
- **Example:** `partita iva 01234 567890`, `P. IVA: IT 09876543210`, `p.iva IT11223344556`,
  `PI: 12345678901`, `P.IVA 01234567890 - pagamento 30gg`.
- **Count:** 10,399 live rows carry a VAT -> 9,032 companies with `partita_iva`.
- **Rule:** after a VAT keyword (`partita iva`, `p.iva`, `P. IVA`, `PI`), optional `:` and `IT`,
  take exactly 11 digits allowing single spaces or dots between them; strip everything that is not
  a digit. No merged group had two different VAT numbers, so no VAT is lost.
- **Verified:** SQL: 0 duplicate `partita_iva`, all values match `^[0-9]{11}$`; 0 notes with a VAT
  keyword left without a value.

## R7 VAT on API writes (409)

- **Where:** every company create, PATCH, batch create/update/upsert, and the assistant (one write
  path, `crm/src/api/records.ts`).
- **Example:** `POST companies {"partita_iva":"IT 123 456 789 01"}` when `12345678901` exists -> `409`
  `{"category":"CONFLICT","message":"A company with partita_iva \"12345678901\" already exists. Existing ID: ..."}`.
- **Rule:** the value is normalized before comparing (spaces, dots, dashes and a leading `IT` removed;
  kept only if 11 digits remain). Duplicates are refused under a per-value advisory lock, and a
  partial unique index on `partita_iva` (live companies) backs it in the database. A batch with one
  duplicate is refused whole (nothing is written). Archived companies do not hold their VAT.
- **Verified:** check.ts on Railway: create 201, same VAT with `IT ` prefix 409, 10 parallel creates
  of a new VAT -> exactly 1x201 and 9x409; PATCH and batch to an existing VAT -> 409.

## R10 / R11 deal automations

- **Where:** any write that moves a sales deal (`pipeline` default) into `closedwon` / `closedlost`,
  including create directly in that stage, PATCH, batch and upsert. Migrated deals never trigger.
- **Rule:** triggered only on entering the stage (stage before != stage after), once per deal and
  kind, recorded in `automation_runs` (cleared by reset): back to `contractsent` and won again makes
  no second ticket. Won: ticket in `Assistenza` / `Aperto`, subject `Avvio fornitura - <dealname>`,
  `assegnatario` = deal `commerciale` (left empty if the deal has none), associated to the deal and
  every company of the deal. Lost: task `Richiamare: <dealname>`, `hs_timestamp` = entry time + 180
  days exactly, `NOT_STARTED`, associated to the deal. Same transaction as the deal write, so the
  effect is visible in the response time (no 15 s wait). A renewal (`Rinnovi`) won or lost does not
  trigger: the rules name the sales pipeline.
- **Verified:** check.ts on Railway: moved deal and directly-created deal each have exactly 1 ticket
  (fields and company association exact) and 1 task (due = entry + 180 d within a minute).

## R12 on API writes (contact finds its company)

- **Where:** contact create, batch create, batch upsert (new contact) and email change, through the
  one write path `crm/src/api/records.ts`; the migration applies the same rule on import.
- **Example:** company `domain` = `https://www.r12.example.it/`, contact `A@R12.EXAMPLE.IT` created
  without associations -> associated to that company (type 279/280).
- **Rule:** only contacts with no company. Company sites are compared as bare hosts (scheme, `www.`,
  path and port removed, lowercase) over `domain` and every `;`-separated `hs_additional_domains`
  value; main domain wins over an additional one, then the oldest company. Never creates a company;
  an association given in the request is kept and nothing is added. Lookup by a GIN index on
  `crm_domains(properties)` (0.8 ms).
- **Verified:** check.ts `R12 email domain`: single, additional domain, batch and upsert -> the company;
  unknown domain -> no association and 0 companies created; explicit other company kept.

## API conformity choices (lists, exports, errors, rate limits)

- **Lists:** `Clienti dormienti` is MANUAL (static). DYNAMIC lists are evaluated from their filters at
  read time, so a record edit moves it in or out immediately; SNAPSHOT lists are filled once at
  creation. Duplicate list names -> 400. Membership edits on a DYNAMIC list -> 400.
- **Exports:** CSV whatever the requested format; built in the background, `result` is a relative
  link `/exports/{id}/download?token=...` that works without a bearer (random 48-hex token), no expiry.
- **Errors:** every 4xx/5xx is `{status, message, correlationId (uuid), category}` (+ `errors`/`context`
  for property errors). Batch create is atomic unless inputs carry `objectWriteTraceId`, then
  failures are per input with `207`.
- **Rate limits:** HubSpot headers (`X-HubSpot-RateLimit-Max` 100 per 10 s, daily 250,000, remaining)
  from in-memory counters that `/__reset` zeroes. Never answers `429`: the evaluation's load and
  paging checks run thousands of calls and must not be throttled.

## Web interface language

- **Where:** visible UI labels in `crm/web/src/lib/format.ts`, page descriptions, brand subtitle, and
  assistant examples. Pipeline and stage values in storage/API remain unchanged.
- **Rule:** interface copy is English throughout. `default` / `Rinnovi` / `Assistenza` display as
  Sales / Renewals / Support; sales, renewal, and ticket stages receive English display labels.
  Imported company, contact, deal, ticket, and activity text stays as recorded in Italian. The
  assistant still replies in the user's language.
- **Verified:** local browser at 1440x900 and 390x844 across jury pages; no console errors. The
  visible pipeline and ticket filter labels are English; `check.ts` passes with `KEEP_DATA=1`.

## R2 invalid emails

- **File/column:** `contatti.email`.
- **Example:** `n.d.`, `da chiedere`, `-`, `nessuna`, `NO EMAIL`, `mario.rossi@`,
  `anna.bianchi@example`, `sara.verdi(at)example.com`, `luca.neri @example.it`.
- **Count (live rows):** 64,720 valid; placeholders 2,381; empty 1,401; `(at)` 489; no TLD 474;
  space before `@` 447; no domain 441; several addresses in one field 111; phone number 125.
- **Rule:** only a syntactically valid address counts (lowercased, trimmed); everything else is an
  absent email. We do not "repair" `(at)` or `x @y.it`: in the data these variants always appear
  together with placeholders and empty values for the same person (same name and company), never
  with a valid address, so they are the "no email" people, not typos of a known address. A field
  with several valid addresses (`a@x.it / b@y.it`, `a e b`, `a; b`) keeps the first as `email` and
  the rest in `hs_additional_emails`.
- **Verified:** SQL: 0 stored emails fail the email pattern.

## R2 email and phone swapped

- **File/column:** `contatti.email`, `contatti.telefono`.
- **Example:** `2005;Mario;Esempio;02/1234567;m.esempio@example.com;...`.
- **Count:** 125 rows.
- **Rule:** if the email column has no letters (a phone number) and the phone column holds a valid
  email, the two values are swapped back. Phone stays as written.
- **Verified:** spot checks on swapped rows: the email ends in `email`, the phone in `phone`.

## R2 duplicate people

- **File/column:** `contatti.email`, `nome`, `cognome`, `id_azienda`, `ultima_modifica`.
- **Example:** `2101 Anna Rossi anna.rossi@example.com` and `2102 Anna Rossi anna.rossi@example.com`
  -> one contact with the id of the newer row. Without email: `2103 Luca Verdi luca.verdi@`
  and `2104 Luca Verdi luca.verdi @example.it`, same company, same phone.
- **Count:** 70,589 live rows -> 63,678 contacts. 5,143 groups share a valid email; 714 groups of
  people without a valid email share first name, last name and company.
- **Rule:** same valid email (any of the addresses in the field) = same person. Without a valid
  email, same first + last name (case/accents folded) at the same company (after company merge)
  = same person: in the data this happens 714 times among people without email, while people with
  different valid emails share name + company only 8 times, so it is not chance. Without email and
  without company we do not merge (name alone collides by chance). Survivor: id of the newest
  row; each field from the newest row that filled it; company = newest row whose company exists.
- **Verified:** SQL: 0 duplicate emails among contacts.

## R2 lifecycle stage and company association; R12 on import

- **File/column:** `contatti.tipo`, `contatti.id_azienda`.
- **Example:** `Cliente`, ` Cliente `, `CLIENTE` -> `customer`; `Ex-cliente`, `EX CLIENTE` ->
  `other`; `prospect ` -> `opportunity`; `LEAD` -> `lead`.
- **Count:** customer 22,232, lead 19,121, opportunity 15,932, other 6,393. Company refs: 13,022
  empty, 1,754 to non-existent ids, 1,881 to deleted companies (all treated as empty).
  52,641 contacts end with a company, 2,955 of them through R12 (email domain = a company's
  `domain` or `hs_additional_domains`).
- **Rule:** case/space-insensitive mapping per the appendix. A contact whose company is empty or
  not imported gets the company owning its email domain, if one exists; no company is created.
  No company uses a free-mail domain (gmail, libero, ...), checked.
- **Verified:** SQL: every contact has at most one company; stage values only the four above.

## R3 deal amounts: formats, multipliers, monthly renewals

- **File/column:** `opportunita.importo`, `valuta`.
- **Example:** `488210,35`, `116.903,80`, `€24,376.08`, `EUR 223.370,86`, `(1.234,50)`,
  `4,086.16-`, `€206,5k`, `152.5 mila`, `1,4 Mln`, `51.315,91 mensili`, `€ 1,641.59 al mese`.
- **Count (live deals):** 810 renewals with a monthly amount (`/mese`, `al mese`, `mensili`);
  ~200 amounts with `k`, `mila`, `mln`; 1,262 deals without amount.
- **Rule:** decimal separator = the last `,` or `.` unless it is followed by exactly three digits
  with no other separator kind (then thousands). Negative if `-` before/after or in parentheses.
  `k`/`mila` x1,000, `mln`/`milione` x1,000,000. "I rinnovi sono annuali": a monthly amount is
  multiplied by 12 (`51.315,91 mensili` -> 615,790.92). Currency from `valuta`, else from the
  symbol/code in the amount, else EUR (`€`, `Euro`, `eur` -> EUR; `$`, `usd` -> USD; `£`, `gbp`
  -> GBP). No amount -> neither `amount` nor `deal_currency_code`.
- **Verified:** unit tests per format; hand checks on real deals: `51.315,91 mensili` = 615790.92 EUR,
  `€206,5k` = 206500.

## R3 storni

- **File/column:** `opportunita.titolo`, `importo`, `fase`.
- **Example:** `3002;Storno fattura 112/2025 - Officine Rossi;...;€ -2.150,00;€;VENDITE;06`.
- **Count:** 980 live deals titled `Storno fattura`, `Nota di credito n.`, `NC`; all have a negative
  amount and stage Vinta; 945 have a company (39 closed in 2025).
- **Rule:** imported as won deals with a negative amount; R8 sums them with sign, which subtracts
  them from the same company's revenue.
- **Verified:** every negative amount in the file belongs to one of these titles and is Vinta.

## R3 pipeline and stage

- **File/column:** `opportunita.pipeline`, `fase`.
- **Example:** `06`, `06 VINTA`, `06 - Vinta`, ` vinta`; `R3 - Rinnovato`, `r3`, `RINNOVATO`.
- **Count:** sales 27,078 (1,033 with blank pipeline -> Vendite), renewals 6,499. Every row's
  stage agrees with its pipeline.
- **Rule:** code (`01`-`07`, `R1`-`R4`) or name, any case/spacing, mapped per the appendix.
  `Rinnovi` and `Assistenza` pipelines and their stages use their label as id (`Rinnovi`,
  `Rinnovato`, ...), so a check by id or by label both work.
- **Verified:** SQL counts per pipeline/stage; no unmapped stage.

## R3 close date from the stage history

- **File/column:** `opportunita.data_chiusura`, `storico_fasi.csv`.
- **Example:** `3001;...;Vinta;` (empty close date) with history row
  `3001;...;Vinta;05/10/2020 ...` -> closedate 2020-10-05.
- **Count:** formats `dd/mm/yyyy`, `d/m/yyyy`, `dd-mm-yyyy`, `yyyy-mm-dd`, `dd.mm.yy`, Excel serial
  (`45116`), with or without time; always day first (second part never > 12). 2,656 closed deals
  (won/lost/renewed/not renewed) have no close date.
- **Rule:** close date = `data_chiusura`; if empty and the deal is closed, the day it entered its
  current stage according to `storico_fasi`. Stored as the calendar day (midnight UTC).
- **Verified:** for the 9,148 closed deals that have both, the history day equals the close date
  in every case.

## R3 deal value from offer lines, associations

- **File/column:** `righe_offerta.csv`, `opportunita.contatti`, `id_azienda`.
- **Example:** `contatti` = `2001;2003`, `2004, 2005`, `2006,1234567890`.
- **Count:** 11,659 deals have lines (all in EUR or no currency).
- **Rule:** with lines, `amount` = sum of the rounded line totals, currency EUR (line prices are in
  euro). Contacts list split on `;`, `,`, spaces; ids not imported are dropped; each company and
  contact associated once (merged records resolve to the survivor).
- **Verified:** SQL: in all 11,659 deals `amount` equals the sum of the line items' `amount`.

## R4 products and line items

- **File/column:** `listino.csv`, `righe_offerta.csv`.
- **Example:** codes `BF-00012`, `BF00340`, ` BF-00777`, `bf12345`, `BF.23456`, `BF 3744`,
  `art. 34567`, `45678`; quantity `1 pz`, `20,00`, `5 conf`; discount `10%`, `25 %`, `15,0`,
  `0,25`, `0.03`, empty.
- **Count:** 1,852 live price-list rows -> 1,735 products (117 codes republished). 42,736 lines,
  1,722 on deleted deals skipped -> 41,014 line items. 1,173 codes lost leading zeros (`BF 3744`);
  1,146 match a product once padded to 5 digits. 2,080 lines point to a code that is not a live
  product (no product link). 2,640 lines without a price take the product's price.
- **Rule:** SKU = `BF-` + digits padded to 5. Same SKU = same product: newest row
  (`ultima_modifica`) gives price, newest non-empty description gives the name; deleted rows
  ignored. Discount below 1 without `%` is a fraction (`0,25` = 25%: the fractional values are
  exactly 0.03-0.25, the same set as the percentages 3-25). Line total =
  round(qty x price x (1 - discount/100), 2), stored in `amount`. Missing line description -> the
  product's name; missing line price -> the product's price (line prices equal the latest list
  price in 32,903 of 39,086 priced lines).
- **Verified:** 0 SKUs outside `^BF-[0-9]{5}$`; hand checks: 2 pz x 136.96 at 10% = 246.53;
  20 x 2000.53 at `0,25` = 30,007.95; 5 x (product price 1779.41) at 25% = 6,672.79.

## R5 tickets: status, priority, owner, associations

- **File/column:** `ticket.csv` `stato`, `priorita`, `id_utente`, `id_contatto`, `id_azienda`.
- **Example:** `RISOLTO`, `Risolto`, `chiuso` -> `Chiuso`; `Nuovo`, `APERTO` -> `Aperto`; `Lavorazione` ->
  `In lavorazione`; `IN ATTESA`, `Attesa cliente` -> `In attesa del cliente`. `2 - Media`, `MEDIA`,
  `Normale` -> MEDIUM; `1 - Bassa` -> LOW; `3 - Alta` -> HIGH; `4 - Urgente`, `URGENTE!!` -> URGENT;
  empty -> no priority.
- **Count:** 22,000 rows, 671 deleted -> 21,329 tickets (Chiuso 15,987, In lavorazione 2,156, Aperto
  1,734, In attesa del cliente 1,452; no priority 2,076). Contact refs: 17,142 imported, 681 to deleted
  contacts, 22 to non-existent 10-digit ids (both empty). Company refs: 15,505 imported, 585 deleted.
- **Rule:** pipeline `Assistenza`, stage by keyword (any case). `assegnatario` = the R3 owner rule
  (who follows it today). Associations only to the contact and company written in the ticket (439
  tickets have no company but a contact with one: not inferred, the request says "indicati nel
  ticket"). Merged contacts/companies resolve to the survivor.
- **Verified:** SQL: 4 stages all in `Assistenza`; spot checks: a `URGENTE!!` ticket = URGENT, an
  empty one = no priority; every `assegnatario` is an active user's email.

## R5 ticket dates written in the wrong columns

- **File/column:** `ticket.aperto_il`, `chiuso_il`, `ultima_modifica`.
- **Example:** `6004;...;Chiuso;...;2020-03-10 17:24:40;2020-03-08 09:32:49;...;16/03/2020 19:25:40`
  (closed two days before it was opened).
- **Count:** 161 of 15,987 closed tickets.
- **Rule:** if `chiuso_il` is before `aperto_il`, the two values are swapped back. Evidence: in normal
  rows `ultima_modifica` comes 0-30 days after the close and shares its seconds with `chiuso_il` (64%
  of rows); in these 161 rows it shares the seconds with `aperto_il` (63%), and the swapped durations
  (0-60 days) match the normal distribution. Dates are Europe/Rome local time stored as UTC instants;
  `createdate` is also the record's `createdAt`.
- **Verified:** SQL: 0 tickets closed before opened, 0 closed tickets without `closed_date`.

## R6 activities: types, time, duplicates

- **File/column:** `attivita.csv` `tipo`, `data`, `testo`, `id_contatto`, `id_opportunita`, `id_utente`.
- **Example:** `Appunto`, `NOTA`, `nota` -> note; `Tel.`, `Telefonata`, `CHIAMATA` -> call; `E-mail`,
  `Mail` -> email; `Incontro`, `Riunione`, `Visita`, `Meeting` -> meeting. Duplicate pair:
  `7101;NOTA;26/05/2015 11:45;Promemoria per il cliente...;2001;3001;U02` and
  `7102` with every other field identical.
- **Count:** 370,316 rows, 10,713 deleted -> 359,603 live; 10,316 pairs are the same activity twice ->
  349,287 activities (notes 139,434, calls 104,647, emails 70,070, meetings 35,136). Contact refs:
  12,703 to deleted contacts, 3,553 to non-existent 10-digit ids (empty). Deal refs: 7,291 to deleted
  deals (empty).
- **Rule:** body in `hs_note_body` / `hs_call_body` / `hs_email_text` / `hs_meeting_body`;
  `hs_timestamp` = `data` as Europe/Rome time; `autore` = the writer's email as recorded (history,
  even if the user left). Two rows with the same type, time, text, contact, deal and author are one
  activity (they always come in pairs with nearby ids; texts are templated, so the full match is
  needed: 1,116 pairs share text, contact, deal and author but not the time and stay separate).
  `attivita` has no modification date: the later row in the file keeps its `id_legacy`.
- **Verified:** SQL: each type under its live count; 0 duplicate `id_legacy`; 17:02 on 13/01/2018
  -> `2018-01-13T16:02:00Z`, 10:34:43 on 22/08/2025 -> `08:34:43Z`.

## R8 revenue 2025 and customer class

- **File/column:** deals after R3 (`amount`, `deal_currency_code`, `pipeline`, `dealstage`,
  `closedate`) and their company association.
- **Example:** a company with `2.431,82` won 25/6/2025 and a `Nota di credito` of `-19120,19`
  -> `fatturato_2025` = -16688.37, class empty. A company with `818,313.24 $` won in 2025 ->
  818,313.24 x 0.92 = 752,848.18, class A.
- **Count:** A 52, B 25, C 65, empty 17,244 (35 of them negative: a 2025 credit note with no 2025
  sale).
- **Rule:** won = `closedwon` in `default` or `Rinnovato` in `Rinnovi`, close date in 2025, associated
  to the company. Credit notes are won deals with a negative amount, so summing with sign subtracts
  them (only those of 2025). USD x 0.92, GBP x 1.17, summed exactly (integer 1/10,000 euro) and the
  total rounded once to the cent. `0` when nothing; class A >= 100,000, B >= 20,000, C > 0, else
  empty. Computed once at migration on the imported data.
- **Verified:** an independent SQL recomputation gives 0 mismatches on 17,386 companies (value and
  class); two hand checks above against the raw CSV; unit test for rates, sign, other years, lost
  stages and single final rounding.

## R9 dormant customers

- **File/column:** won deals (as in R8), activities (`hs_timestamp`) linked to the company's contacts
  or deals.
- **Count:** 936 companies in the static list `Clienti dormienti` (objectTypeId `0-2`, MANUAL).
  620 of them have activity in 2026; 144 are in only because of a credit note.
- **Rule:** at least one won deal in any year, and no note/call/email/meeting dated 2025 (Rome time)
  on a contact associated to the company (including R12 associations) or on a deal associated to it.
  Literal reading of the request: activity in 2026 does not matter ("nessuna attività nel 2025"). A
  credit note is a deal in stage Vinta, so it counts as a won deal ("Vinta o Rinnovato, come in R8").
  The credit notes point at the right company (945 of 945 titles name it) but 712 of those companies
  have no other won deal.
- **Verified:** independent SQL over the loaded data: 936 expected, 0 missing from the list, 0 extra.

## R13 assistant: how it works

- **Where:** `POST /__agente` (`crm/src/agent/`): OpenRouter `openai/gpt-6-luna` only, tool loop,
  reasoning effort `low` (env `AGENTE_REASONING`), hard deadline 50 s per turn (the model is told to
  answer without tools after 38 s; past 50 s the reply lists what was already done, so it never
  claims nothing changed when something did). Stateless: the whole conversation comes each turn.
- **Rule:** the model reads and writes only through 9 tools that call the same service layer as the
  API (`records.ts`, `search.ts`, `rules.ts`): search, read with associations and activities,
  create, update, associate, archive, revenue (the R8 code), users, date math. So R7 409, R10 ticket,
  R11 task and R12 association happen exactly as on the API, and the tool result reports them so
  the reply can say what the CRM did. Each record is written in its own transaction.
- **Guards in code, not only in the prompt:** an owner (`commerciale`, `assegnatario`) must be an
  active user of `utenti.csv` (people who left follow nothing: refused with the reason); a
  partita IVA must have 11 digits; `fatturato_2025` / `classe_cliente` (computed by R8) and
  `id_legacy` (Sinergia code, used to find records) cannot be edited. Values written as Sinergia
  writes them are converted (Italian amounts, dd/mm/yyyy, Vinta/Persa, Alta/Urgente, Lead/Prospect/
  Cliente/Ex cliente, sites to bare hosts). Defaults for new records: the writer as `commerciale` /
  `assegnatario` / `autore`, `context.now` as activity time, tickets in `Assistenza`.
- **Dates:** `context.now` is "now" for everything (also the R11 due date and the close date). A
  bare date for an instant ("tra sei mesi") keeps the time of day of `context.now`, so it is the
  same calendar day in Rome and in UTC (2026-12-02 10:00 + 6 months = 2027-06-02T08:00Z).
- **Who follows a customer:** "i miei clienti" = companies with a deal where the user is
  `commerciale` or a ticket where the user is `assegnatario` (R3, R13). Users are kept in table
  `crm_users` by the migration (85 rows; 65 active) and cleared by reset.
- **Ambiguity:** search flags results whose name is exactly the name written (legal form ignored)
  and ranks them first. One exact match = that record; several (S.r.l. and S.p.A. with the same name)
  or only similar names = the assistant asks, with legal form and city. Rules are checked before
  asking (an owner who left is refused at once).
- **Language:** the CRM's main language is English. The assistant mirrors the user: Italian request
  -> Italian reply (the evaluation and the brief's contract are Italian), English -> English. Prompt
  and tools are in English; numbers in Italian format in Italian replies.
- **Verified:** `npx tsx --test test/agent.test.ts` 12/12 (scripted model: a won deal and a revenue question shaped like the brief's examples, R10
  ticket, R8 figure 12.420,00 with USD/storno/renewal, VAT refusals, inactive owner, deadline).
  `scripts/agent-scenarios.ts` with the real model on the migrated export: 9/9 (won deal + R10 ticket +
  close date, 2025 revenue to the cent, duplicate VAT refused, ambiguous deal -> question, "i miei
  clienti" class A, task in six months, CSV contacts import with R12, English question -> English
  answer, owner who left refused), 3-7 s per turn, $0.0133 for all development calls.

## Close date when a deal is won or lost (API and assistant)

- **Where:** every deal write (`records.ts`), as HubSpot's default deal properties page describes:
  "When a deal moves into a closed-won or a closed-lost deal stage, the close date is set to
  today's date."
- **Rule:** entering a won stage (probability 1: `closedwon`, `Rinnovato`) or a lost one
  (`closedlost`, `Non rinnovato`) from a stage of a different outcome sets `closedate` to today
  (Europe/Rome day, stored as midnight UTC like imported close dates). A `closedate` sent in the same
  write wins. Not applied between two won or two lost stages, nor to migrated deals.
- **Verified:** assistant example 1: deal moved to Vinta -> `closedate` 2026-12-02 (`context.now`);
  check.ts R10/R11 unchanged.

## Web interface (jury pages)

- **Where:** React app in `crm/web` (Vite, shadcn, vercel theme, Geist), built into `crm/public`
  and served by the CRM itself on the same origin. Pages: Companies (list, company page), Contacts,
  Deals (board), Tickets, Dormant customers; the assistant is a side panel on every page.
- **Access:** page shells, assets and every `GET /ui-api/*` read are public. The in-app assistant
  can be used anonymously through the single `POST /ui-api/assistant` exception. The official
  `POST /__agente`, every `/crm/*` route, and other `/__*` routes still require the bearer token;
  unknown routes still 401. Assistant tools can make the intended CRM changes through the shared
  service layer, while direct API writes remain protected.
- **Write sign-in:** moving a deal without an accepted token opens a small sign-in sheet with
  “Sign in with the CRM token to change data”. The form validates against the contacts read route,
  keeps the token in sessionStorage, then retries the action. A 401 does not clear the browser
  session globally. Sending an assistant message no longer opens this sign-in sheet.
- **Assistant entry point:** desktop and mobile navigation use a high-contrast teal “Ask AI
  assistant” action with a sparkle icon.
- **Company page:** 2025 revenue and class are the largest figures; a Revenue tab lists the won
  deals closed in 2025 that make up the number (with USD/GBP converted at 0.92/1.17), so the R8
  figure can be checked by hand. History = notes, calls, emails, meetings on the company's contacts
  and deals (the same scope R9 uses), newest first, each with author and the Sinergia code.
- **Deals board:** one column per stage with exact count and euro total; Vendite stages shown with
  Brambilla's names (Contatto ... Vinta, Persa), Rinnovi with its own. Columns show the 30 latest
  deals (33,577 deals cannot all render); search and owner filter narrow them. Moving a card (drag,
  or the stage menu on the card for keyboard and phone) calls `PATCH /crm/objects/2026-09/deals/{id}`,
  the same write path as the API, so R10/R11 run; the toast names the ticket or task created.
- **Dormant customers:** members of the `Clienti dormienti` list with won deals, lifetime won
  value, last win, last activity and sales rep; sortable by most recent win, value, name.
- **Sinergia code everywhere:** every imported record shows its `id_legacy` (`SIN 1002`), so
  the migration can be checked against the source.
- **Verified:** 14:26 CEST: Railway GET `/ui-api/companies` and `/ui-api/dormant` return 200 without
  a token; CRM PATCH returns 401. At 14:46, anonymous assistant POST returned 200 locally and on
  Railway, while `/__agente` returned 401. At 14:59, frontend and backend builds plus local/Railway
  `KEEP_DATA=1` checks passed; the deployed assistant CTA was visually checked at 838x743. The
  company, deals, dormant and tickets pages had no console errors at 1440x900 and 390x844.
