import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "../src/migrate/csv.js";
import {
  activityType, dealStage, isDeleted, lifecycleStage, normalizeDomain, normalizeEmail, normalizeSku,
  parseCurrency, parseLocalDate, parseNumber, parseQuantity, romeToIso, ticketPriority, ticketStage, toIsoDate,
} from "../src/migrate/normalize.js";
import { UserDirectory } from "../src/migrate/users.js";

test("csv: quotes, separators and newlines inside fields", () => {
  const rows = parseCsv('a;b;c\r\n1;"x;y";" z "\r\n2;"line1\r\nline2 ""q""";\r\n');
  assert.deepEqual(rows, [{ a: "1", b: "x;y", c: "z" }, { a: "2", b: 'line1\nline2 "q"', c: "" }]);
});

test("deleted markers", () => {
  for (const v of ["S", "s", "SI", "Sì", "1"]) assert.equal(isDeleted(v), true, v);
  for (const v of ["", "0", "N", "NO"]) assert.equal(isDeleted(v), false, v);
});

test("numbers in Italian and English formats", () => {
  const cases: Array<[string, number | null]> = [
    ["488210,35", 488210.35], ["116.903,80", 116903.8], ["€24,376.08", 24376.08],
    ["€ 1027956.14", 1027956.14], ["EUR 223.370,86", 223370.86], ["€ -5.131,24", -5131.24],
    ["4,086.16-", -4086.16], ["- 21.527,35", -21527.35], ["(1.234,50)", -1234.5],
    ["1.151,12", 1151.12], ["15,17", 15.17], ["9.999.999,99", 9999999.99], ["1,234,567.89", 1234567.89],
    ["USD 12.000", 12000], ["", null], ["n.d.", null],
  ];
  for (const [input, expected] of cases) assert.equal(parseNumber(input), expected, input);
});

test("currency", () => {
  assert.equal(parseCurrency("", "€ 12,00"), "EUR");
  assert.equal(parseCurrency("usd", ""), "USD");
  assert.equal(parseCurrency("", "$ 1,00"), "USD");
  assert.equal(parseCurrency("£"), "GBP");
  assert.equal(parseCurrency("", "12,00"), null);
});

test("dates day first, serials, two-digit years, Rome time", () => {
  assert.equal(toIsoDate(parseLocalDate("18/01/2015")), "2015-01-18T00:00:00.000Z");
  assert.equal(toIsoDate(parseLocalDate("2018-05-17")), "2018-05-17T00:00:00.000Z");
  assert.equal(toIsoDate(parseLocalDate("20-04-2017")), "2017-04-20T00:00:00.000Z");
  assert.equal(toIsoDate(parseLocalDate("5/3/2019")), "2019-03-05T00:00:00.000Z");
  assert.equal(toIsoDate(parseLocalDate("13.08.21")), "2021-08-13T00:00:00.000Z");
  assert.equal(toIsoDate(parseLocalDate("45116")), "2023-07-09T00:00:00.000Z");
  assert.equal(romeToIso(parseLocalDate("13/01/2018 17:02")), "2018-01-13T16:02:00.000Z");
  assert.equal(romeToIso(parseLocalDate("16/07/2014 00:00:00")), "2014-07-15T22:00:00.000Z");
});

test("domains and emails", () => {
  assert.equal(normalizeDomain("https://www.Example.it/contatti"), "example.it");
  assert.equal(normalizeDomain("www.impianti-esempio.eu"), "impianti-esempio.eu");
  assert.equal(normalizeDomain("http://esempiogroup.it:8080"), "esempiogroup.it");
  assert.equal(normalizeDomain("n/d"), "");
  assert.equal(normalizeEmail(" MARIOROSSI@Example.IT "), "mariorossi@example.it");
  assert.equal(normalizeEmail("mario.rossi@"), "");
  assert.equal(normalizeEmail("mario rossi@x.it"), "");
  assert.equal(normalizeEmail("mario@x"), "");
});

test("enumerations", () => {
  assert.equal(lifecycleStage(" cliente "), "customer");
  assert.equal(lifecycleStage("Ex cliente"), "other");
  assert.equal(lifecycleStage("Prospect"), "opportunity");
  assert.equal(lifecycleStage("LEAD"), "lead");
  assert.deepEqual(dealStage("06 - Vinta"), { pipeline: "sales", stage: "closedwon" });
  assert.deepEqual(dealStage(" persa"), { pipeline: "sales", stage: "closedlost" });
  assert.deepEqual(dealStage("02 QUALIFICA"), { pipeline: "sales", stage: "qualifiedtobuy" });
  assert.deepEqual(dealStage("R3 - Rinnovato"), { pipeline: "renewals", stage: "Rinnovato" });
  assert.deepEqual(dealStage("r4"), { pipeline: "renewals", stage: "Non rinnovato" });
  assert.deepEqual(dealStage("NON RINNOVATO"), { pipeline: "renewals", stage: "Non rinnovato" });
  assert.deepEqual(dealStage("In trattativa"), { pipeline: "renewals", stage: "In trattativa" });
  assert.equal(ticketStage("Risolto"), "Chiuso");
  assert.equal(ticketStage("Attesa cliente"), "In attesa del cliente");
  assert.equal(ticketStage("Nuovo"), "Aperto");
  assert.equal(ticketPriority("URGENTE!!"), "URGENT");
  assert.equal(ticketPriority("Normale"), "MEDIUM");
  assert.equal(ticketPriority(""), "");
  assert.equal(activityType("Tel."), "calls");
  assert.equal(activityType("E-mail"), "emails");
  assert.equal(activityType("Visita"), "meetings");
  assert.equal(activityType("Appunto"), "notes");
  assert.equal(normalizeSku(" BF-00777"), "BF-00777");
  assert.equal(normalizeSku("BF00340"), "BF-00340");
  assert.equal(parseQuantity("1 pz"), 1);
  assert.equal(parseQuantity("20,00"), 20);
});

test("users: active, left with active manager, chain, same person new account, names", () => {
  const users = new UserDirectory(parseCsv([
    "id_utente;nome;cognome;email;ruolo;responsabile;attivo",
    "U01;Giulia;Ferri;giulia.ferri@example.com;Direttore;;s",
    "U05;Marco;Riva;marco.riva@example.com;Responsabile;U01;n",
    "U07;Sara;Galli;sara.galli@example.com;Responsabile;U01;SI",
    "U12;Anna;Dell'Esempio;anna.dellesempio@example.com;Commerciale;U07;N",
    "U47;Paolo;Conti;paolo.conti@example.com;Commerciale;U05;n",
    "U48;Luca;Bassi;luca.bassi@example.com;Commerciale;U05;NO",
    "U83;Paolo;Conti;p.conti@example.com;Commerciale;U02;S",
    "U36;Elena;Colombo;elena.colombo@example.com;Commerciale;U07;SI",
  ].join("\n")));
  assert.equal(users.ownerEmail("U07"), "sara.galli@example.com");
  assert.equal(users.ownerEmail("U12"), "sara.galli@example.com");
  assert.equal(users.ownerEmail("U48"), "giulia.ferri@example.com");
  assert.equal(users.ownerEmail("U47"), "p.conti@example.com");
  assert.equal(users.ownerEmail("Colombo E."), "elena.colombo@example.com");
  assert.equal(users.ownerEmail("DELL'ESEMPIO ANNA"), "sara.galli@example.com");
  assert.equal(users.ownerEmail("paolo conti"), "p.conti@example.com");
  assert.equal(users.ownerEmail(""), "");
  assert.equal(users.ownerEmail("U99"), "");
  assert.equal(users.authorEmail("U47"), "paolo.conti@example.com");
});

test("amounts with multipliers and monthly renewals; discounts", async () => {
  const { parseAmount, parseDiscount } = await import("../src/migrate/normalize.js");
  assert.deepEqual(parseAmount("€206,5k"), { value: 206500, monthly: false });
  assert.deepEqual(parseAmount("95.5k"), { value: 95500, monthly: false });
  assert.deepEqual(parseAmount("152.5 mila"), { value: 152500, monthly: false });
  assert.deepEqual(parseAmount("1,4 Mln"), { value: 1400000, monthly: false });
  assert.deepEqual(parseAmount("EUR 1.4mln"), { value: 1400000, monthly: false });
  assert.deepEqual(parseAmount("€ 1,641.59 al mese"), { value: 19699.08, monthly: true });
  assert.deepEqual(parseAmount("51.315,91 mensili"), { value: 615790.92, monthly: true });
  assert.deepEqual(parseAmount("500,59 /mese"), { value: 6007.08, monthly: true });
  assert.deepEqual(parseAmount("€ -5.131,24"), { value: -5131.24, monthly: false });
  assert.equal(parseAmount(""), null);
  assert.equal(parseDiscount("0,25"), 25);
  assert.equal(parseDiscount("0.03"), 3);
  assert.equal(parseDiscount("25 %"), 25);
  assert.equal(parseDiscount("15,0"), 15);
  assert.equal(parseDiscount("0%"), 0);
  assert.equal(parseDiscount(""), 0);
});

test("R8 revenue: won deals of 2025, fixed rates, storni subtract, total rounded once", async () => {
  const { revenueCents, customerClass, romeYear, centsToString } = await import("../src/migrate/rules.js");
  const deal = (amount: string | null, extra: Record<string, string> = {}) =>
    ({ pipeline: "default", dealstage: "closedwon", closedate: "2025-06-01T00:00:00.000Z", amount, ...extra });
  const cents = revenueCents([
    deal("1000.01", { deal_currency_code: "USD" }), // 920.0092
    deal("100.01", { deal_currency_code: "GBP" }), // 117.0117
    deal("2431.82"), deal("-19.12"),
    deal("500", { pipeline: "Rinnovi", dealstage: "Rinnovato" }),
    deal("999", { dealstage: "closedlost" }), deal("999", { pipeline: "Rinnovi", dealstage: "Non rinnovato" }),
    deal("999", { closedate: "2024-12-31T00:00:00.000Z" }), deal(null),
  ]);
  assert.equal(cents, 394972); // 920.0092 + 117.0117 + 2431.82 - 19.12 + 500 = 3949.7209
  assert.equal(centsToString(cents), "3949.72");
  // Rounded once on the total: 3 x 0.046 = 0.138 -> 0.14 (per deal it would be 0.15).
  assert.equal(revenueCents([1, 2, 3].map(() => deal("0.05", { deal_currency_code: "USD" }))), 14);
  assert.equal(revenueCents([]), 0);
  assert.equal(centsToString(0), "0");
  assert.equal(customerClass(10_000_000), "A");
  assert.equal(customerClass(9_999_999), "B");
  assert.equal(customerClass(2_000_000), "B");
  assert.equal(customerClass(1_999_999), "C");
  assert.equal(customerClass(1), "C");
  assert.equal(customerClass(0), "");
  assert.equal(customerClass(-500), "");
  assert.equal(romeYear("2024-12-31T23:30:00.000Z"), 2025); // 00:30 on 1 Jan in Rome
  assert.equal(romeYear("2025-12-31T22:59:00.000Z"), 2025);
});
