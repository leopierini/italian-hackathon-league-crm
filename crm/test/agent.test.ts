// Assistant tests against the local database (DATABASE_URL), with a scripted model: no real
// model calls. Resets the database. Run: npx tsx --test test/agent.test.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeStore, initializeStore, query, resetStore, withTransaction } from "../src/store.js";
import { associate, invalidateSchemaCache } from "../src/api/records.js";
import { createBrambillaSchema } from "../src/migrate/schema.js";
import { createStaticList } from "../src/migrate/load.js";
import { runTool, type AgentContext } from "../src/agent/tools.js";
import { runAgent } from "../src/agent/index.js";
import type { ChatMessage, ModelFn, ToolCall } from "../src/agent/model.js";

const now = new Date("2026-12-02T10:00:00+01:00");
const marco = "marco.riva@brambillaforniture.it";
const sara = "sara.galli@brambillaforniture.it";
const ids: Record<string, string> = {};

const ctx = (user = marco): AgentContext => ({ now, user, actions: [] });
const tool = async (name: string, args: unknown, c = ctx()) => runTool(name, JSON.stringify(args), c) as Promise<any>;

before(async () => {
  await initializeStore();
  await resetStore();
  await withTransaction(async (client) => {
    await createBrambillaSchema(client);
    await client.query(`INSERT INTO crm_users (id, first_name, last_name, email, manager_id, active) VALUES
      ('U02', 'Marco', 'Riva', $1, 'U01', TRUE), ('U04', 'Sara', 'Galli', $2, 'U01', TRUE),
      ('U01', 'Giulia', 'Ferri', 'giulia.ferri@brambillaforniture.it', '', TRUE),
      ('U06', 'Luca', 'Bassi', 'luca.bassi@brambillaforniture.it', 'U02', FALSE)`, [marco, sara]);
  });
  invalidateSchemaCache();
  await withTransaction(async (client) => {
    // Seed rows directly (like the migration): no automations run on setup data.
    const mk = async (type: string, props: Record<string, string>, assoc: Array<[string, string]> = []) => {
      const [row] = await query<{ id: string }>(`INSERT INTO objects (type, properties) VALUES ($1, $2::jsonb) RETURNING id::text`, [type, JSON.stringify(props)], client);
      for (const [toType, toId] of assoc) await associate(client, type, row!.id, toType, toId);
      return row!.id;
    };
    ids.rossi = await mk("companies", { name: "Officine Rossi S.r.l.", domain: "officinerossi.it", city: "Monza", partita_iva: "12345678901", id_legacy: "A1" });
    ids.bianchi = await mk("companies", { name: "Tessitura Bianchi S.p.A.", domain: "tessiturabianchi.com", city: "Como", id_legacy: "A2" });
    ids.dealRossiOpen = await mk("deals", { dealname: "Fornitura utensili 2027", pipeline: "default", dealstage: "contractsent", amount: "15000", deal_currency_code: "EUR", commerciale: marco, id_legacy: "O1" }, [["companies", ids.rossi]]);
    ids.dealRossiOld = await mk("deals", { dealname: "Ordine 2024", pipeline: "default", dealstage: "closedwon", amount: "800", closedate: "2024-03-01T00:00:00.000Z", commerciale: marco, id_legacy: "O2" }, [["companies", ids.rossi]]);
    // Bianchi 2025: won 10.000 EUR + won 1.000 USD (920 EUR) + storno -500 EUR + renewal 2.000 EUR; a 2024 win does not count.
    await mk("deals", { dealname: "Tessuti A", pipeline: "default", dealstage: "closedwon", amount: "10000", deal_currency_code: "EUR", closedate: "2025-02-10T00:00:00.000Z", commerciale: sara, id_legacy: "O3" }, [["companies", ids.bianchi]]);
    await mk("deals", { dealname: "Tessuti USA", pipeline: "default", dealstage: "closedwon", amount: "1000", deal_currency_code: "USD", closedate: "2025-05-10T00:00:00.000Z", commerciale: sara, id_legacy: "O4" }, [["companies", ids.bianchi]]);
    await mk("deals", { dealname: "Storno tessuti", pipeline: "default", dealstage: "closedwon", amount: "-500", deal_currency_code: "EUR", closedate: "2025-06-10T00:00:00.000Z", commerciale: sara, id_legacy: "O5" }, [["companies", ids.bianchi]]);
    await mk("deals", { dealname: "Rinnovo 2025", pipeline: "Rinnovi", dealstage: "Rinnovato", amount: "2000", deal_currency_code: "EUR", closedate: "2025-09-10T00:00:00.000Z", commerciale: sara, id_legacy: "O6" }, [["companies", ids.bianchi]]);
    await mk("deals", { dealname: "Tessuti 2024", pipeline: "default", dealstage: "closedwon", amount: "99999", closedate: "2024-09-10T00:00:00.000Z", commerciale: sara, id_legacy: "O7" }, [["companies", ids.bianchi]]);
    await createStaticList(client, "Clienti dormienti", "0-2", [Number(ids.bianchi)]);
  });
});

after(async () => closeStore());

test("search_records: words in any order, legal suffixes ignored, companies next to deals", async () => {
  const companies = await tool("search_records", { objectType: "companies", text: "rossi officine srl" });
  assert.equal(companies.total, 1);
  assert.equal(companies.results[0].id, ids.rossi);
  const deals = await tool("search_records", { objectType: "deals", associatedWith: { objectType: "companies", id: ids.rossi } });
  assert.equal(deals.total, 2);
  assert.equal(deals.results[0].companies[0].name, "Officine Rossi S.r.l.");
  const users = await tool("list_users", { text: "galli" });
  assert.equal(users.users[0].email, sara);
});

test("search_records: followedBy (my customers) and inList (dormant)", async () => {
  const mine = await tool("search_records", { objectType: "companies", followedBy: sara });
  assert.deepEqual(mine.results.map((r: any) => r.id), [ids.bianchi]);
  const dormant = await tool("search_records", { objectType: "companies", inList: "Clienti dormienti" });
  assert.deepEqual(dormant.results.map((r: any) => r.id), [ids.bianchi]);
});

test("company_revenue: R8 rule (storni, USD, renewals, year)", async () => {
  const result = await tool("company_revenue", { companyIds: [ids.bianchi], year: 2025 });
  assert.equal(result.results[0].revenue_eur, 12420);
  assert.equal(result.results[0].revenue_formatted, "12.420,00 €");
  assert.equal(result.results[0].classe_cliente, "C");
});

test("create_records: duplicate and invalid VAT refused, nothing written", async () => {
  const before = await query(`SELECT count(*)::int AS n FROM objects WHERE type = 'companies'`);
  const dup = await tool("create_records", { objectType: "companies", records: [{ properties: { name: "Copia Rossi", partita_iva: "IT 12345678901" } }] });
  assert.equal(dup.results[0].ok, false);
  assert.match(dup.results[0].error, /409/);
  assert.match(dup.results[0].error, /Officine Rossi/);
  const bad = await tool("create_records", { objectType: "companies", records: [{ properties: { name: "X", partita_iva: "1234" } }] });
  assert.equal(bad.results[0].ok, false);
  assert.match(bad.results[0].error, /11 digits/);
  const afterCount = await query(`SELECT count(*)::int AS n FROM objects WHERE type = 'companies'`);
  assert.deepEqual(afterCount, before);
});

test("create_records: contact finds its company by email domain (R12), reported", async () => {
  const c = ctx();
  const result = await tool("create_records", { objectType: "contacts", records: [{ properties: { firstname: "Anna", lastname: "Rossi", email: "Anna@OfficineRossi.it", lifecyclestage: "Cliente" } }] }, c);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].properties.lifecyclestage, "customer");
  assert.match(result.results[0].automations[0], /Officine Rossi/);
  assert.equal(c.actions.length, 1);
});

test("update_records: owner must be an active user", async () => {
  const result = await tool("update_records", { objectType: "deals", records: [{ id: ids.dealRossiOpen, properties: { commerciale: "Luca Bassi" } }] });
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error, /left the company/);
  const ok = await tool("update_records", { objectType: "deals", records: [{ id: ids.dealRossiOpen, properties: { commerciale: "Giulia Ferri" } }] });
  assert.equal(ok.results[0].changed.commerciale.to, "giulia.ferri@brambillaforniture.it");
  await tool("update_records", { objectType: "deals", records: [{ id: ids.dealRossiOpen, properties: { commerciale: marco } }] });
});

test("fatturato_2025 and id_legacy cannot be edited", async () => {
  const result = await tool("update_records", { objectType: "companies", records: [{ id: ids.rossi, properties: { classe_cliente: "A" } }] });
  assert.equal(result.results[0].ok, false);
  const legacy = await tool("update_records", { objectType: "companies", records: [{ id: ids.rossi, properties: { id_legacy: "Z" } }] });
  assert.equal(legacy.results[0].ok, false);
});

test("date_math from context.now", async () => {
  assert.equal((await tool("date_math", { months: 6 })).date, "2027-06-02");
  assert.equal((await tool("date_math", { days: 1 })).weekday, "giovedì");
});

// Scripted model: each step looks at the last tool results and returns the next call.
function scripted(steps: Array<(results: any[]) => { calls?: Array<[string, unknown]>; text?: string }>): ModelFn {
  let index = 0;
  return async ({ messages }) => {
    const results: any[] = [];
    for (let i = messages.length - 1; i >= 0 && messages[i]!.role === "tool"; i--) results.unshift(JSON.parse((messages[i] as Extract<ChatMessage, { role: "tool" }>).content));
    const step = steps[index++]!(results);
    if (step.text) return { message: { role: "assistant", content: step.text } };
    const tool_calls: ToolCall[] = step.calls!.map(([name, args], n) => ({ id: `call_${index}_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
    return { message: { role: "assistant", content: null, tool_calls }, usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.0001 } };
  };
}

test("won deal: mark the Officine Rossi deal as won -> closedwon, R10 ticket, close date today", async () => {
  let reported = "";
  const model = scripted([
    () => ({ calls: [["search_records", { objectType: "companies", text: "Officine Rossi" }]] }),
    ([companies]) => ({ calls: [["search_records", { objectType: "deals", associatedWith: { objectType: "companies", id: companies.results[0].id } }]] }),
    ([deals]) => {
      const open = deals.results.filter((d: any) => !String(d.dealstage).startsWith("closed"));
      return { calls: [["update_records", { objectType: "deals", records: [{ id: open[0].id, properties: { dealstage: "Vinta" } }] }]] };
    },
    ([update]) => { reported = update.results[0].automations[0]; return { text: "Fatto: la trattativa Fornitura utensili 2027 è ora Vinta." }; },
  ]);
  const started = Date.now();
  const result = await runAgent({
    context: { now: "2026-12-02T10:00:00+01:00", user: marco },
    messages: [{ role: "user", content: "La trattativa di Officine Rossi è vinta: abbiamo ricevuto l'ordine firmato." }],
  }, model);
  assert.ok(Date.now() - started < 1000, "mock run under 1 s");
  assert.match(result.reply, /Vinta/);
  const [deal] = await query<{ properties: any }>(`SELECT properties FROM objects WHERE id = $1`, [ids.dealRossiOpen]);
  assert.equal(deal!.properties.dealstage, "closedwon");
  assert.equal(deal!.properties.closedate, "2026-12-02T00:00:00.000Z");
  const tickets = await query<{ properties: any }>(`SELECT properties FROM objects WHERE type = 'tickets'`);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0]!.properties.subject, "Avvio fornitura - Fornitura utensili 2027");
  assert.equal(tickets[0]!.properties.assegnatario, marco);
  assert.match(reported, /Avvio fornitura/);
  // The old won deal was not touched.
  const [old] = await query<{ properties: any }>(`SELECT properties FROM objects WHERE id = $1`, [ids.dealRossiOld]);
  assert.equal(old!.properties.closedate, "2024-03-01T00:00:00.000Z");
});

test("revenue question: Tessitura Bianchi in 2025", async () => {
  let figure = "";
  const model = scripted([
    () => ({ calls: [["search_records", { objectType: "companies", text: "Tessitura Bianchi" }]] }),
    ([companies]) => ({ calls: [["company_revenue", { companyIds: [companies.results[0].id], year: 2025 }]] }),
    ([revenue]) => { figure = revenue.results[0].revenue_formatted; return { text: `Nel 2025 con Tessitura Bianchi abbiamo fatturato ${figure}.` }; },
  ]);
  const result = await runAgent({
    context: { now: "2026-12-02T10:00:00+01:00", user: sara },
    messages: [{ role: "user", content: "Qual è il fatturato 2025 di Tessitura Bianchi?" }],
  }, model);
  assert.equal(figure, "12.420,00 €");
  assert.match(result.reply, /12\.420,00/);
});

test("deadline: a slow model gets a fallback reply in time, in the user's language", async () => {
  const slow: ModelFn = (_req, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const started = Date.now();
  const result = await runAgent({ context: { now: "2026-12-02T10:00:00+01:00", user: marco }, messages: [{ role: "user", content: "Can you show me my deals please?" }] }, slow, () => {}, { deadlineMs: 4000 });
  assert.ok(Date.now() - started < 4000);
  assert.equal(result.timedOut, true);
  assert.match(result.reply, /Sorry/);
});

test("bad body -> input error", async () => {
  await assert.rejects(runAgent({ messages: [] }, scripted([])), /messages/);
});
