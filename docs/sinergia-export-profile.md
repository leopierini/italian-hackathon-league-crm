# Sinergia export: initial profile

Source: the `export.zip` provided by the organizers (not redistributed in this repo; a small
synthetic export with the same layout is in `crm/sample/`). This is an initial
engineering profile of the provided export, not a complete list of edge cases and not the final
choice-sheet evidence. Row counts and selected category counts below were measured from the
archive on 9 October 2026. The brief says the evaluation export has the same format and size but
different data.

## File inventory

All nine files are under `sinergia-export/`, use semicolon delimiters, and are Windows-1252
encoded. The provided archive has 676,673 CSV data rows in total (the brief rounds this to about
675,000).

| File | Rows | Columns |
|---|---:|---|
| `utenti.csv` | 85 | `id_utente`, `nome`, `cognome`, `email`, `ruolo`, `responsabile`, `attivo` |
| `aziende.csv` | 20,497 | `id_azienda`, `ragione_sociale`, `sito_web`, `note`, `citta`, `provincia`, `cancellato`, `ultima_modifica` |
| `contatti.csv` | 73,391 | `id_contatto`, `nome`, `cognome`, `email`, `telefono`, `id_azienda`, `tipo`, `cancellato`, `ultima_modifica` |
| `opportunita.csv` | 35,020 | `id_opportunita`, `titolo`, `id_azienda`, `contatti`, `importo`, `valuta`, `pipeline`, `fase`, `data_chiusura`, `id_commerciale`, `cancellato`, `ultima_modifica` |
| `storico_fasi.csv` | 110,706 | `id_opportunita`, `fase_precedente`, `fase_nuova`, `data_cambio`, `id_utente` |
| `listino.csv` | 1,922 | `codice_articolo`, `descrizione`, `unita`, `prezzo_listino`, `cancellato`, `ultima_modifica` |
| `righe_offerta.csv` | 42,736 | `id_riga`, `id_opportunita`, `codice_articolo`, `descrizione`, `quantita`, `prezzo_unitario`, `sconto` |
| `ticket.csv` | 22,000 | `id_ticket`, `oggetto`, `descrizione`, `stato`, `priorita`, `id_contatto`, `id_azienda`, `aperto_il`, `chiuso_il`, `id_utente`, `cancellato`, `ultima_modifica` |
| `attivita.csv` | 370,316 | `id_attivita`, `tipo`, `data`, `testo`, `id_contatto`, `id_opportunita`, `id_utente`, `cancellato` |

## Variations observed

These are present in the provided export and should be handled deliberately. Do not assume the
spelling in one row is the only spelling.

- Deleted flags include empty values and variants such as `0`, `NO`, `N`, `S`, `s`,
  `Sì`, `1`, and `SI`. The request says deleted records are omitted; classify the marker
  consistently instead of checking for one literal value. Check every file that has the column.
- Contact lifecycle values vary in case and surrounding whitespace (for example, `Cliente`,
  `CLIENTE`, ` cliente `, `Prospect`, `Lead`, and several spellings of ex-customer).
- Deal pipeline values vary in case and whitespace; some are blank. Deal stages appear as names,
  numeric codes, and combinations of both (for example, `06`, `06 - Vinta`, `Vinta`). The
  stage-history file also contains renewal-stage codes such as `R1`.
- Deal currencies include `EUR`, `eur`, `Euro`, `€`, `USD`, `usd`, `$`, `GBP`,
  `gbp`, and `£`; the request defines fixed conversion rates and says no currency means EUR.
- Amounts and prices use comma decimals in the sampled rows, sometimes with currency symbols,
  thousands separators, or a negative sign. Offer-line quantities include unit text (for example,
  `1 pz`) as well as plain numbers; discounts include a percent sign in some rows.
- Dates appear in both day/month/year and ISO-like forms in sampled rows. Preserve timestamps
  correctly when normalizing.
- Ticket status and priority spellings vary by case and synonym. Examples include `Risolto`,
  `Chiuso`, `In lavorazione`, `Aperto`, `MEDIA`, `Normale`, `Bassa`, `Alta`, and
  `URGENTE!!`.
- Activity types use several names for the same concepts: note (`Appunto`, `Nota`), call
  (`Telefonata`, `Tel.`, `Chiamata`), email (`E-mail`, `Mail`), and meeting
  (`Meeting`, `Riunione`, `Incontro`, `Visita`).

The client's requests document specifies the target records and mappings. This profile
does not decide ambiguous transformations beyond those rules; the decisions are in
[choices.md](choices.md).

## Implementation reminders from the source rules

- Trim names and text values without changing the words people wrote.
- A deleted or missing reference acts as an empty field; a reference to a merged row points to its
  surviving record.
- For duplicate records, keep the legacy ID of the most recently modified row and take each field
  from the most recent row that supplied it.
- Preserve source IDs in `id_legacy` for the objects listed by the client.
- The hidden export differs in data, so logic must use the file contents rather than memorized IDs
  from this copy.
