// Assistant scenarios on the migrated local CRM: picks real records from the database
// (DATABASE_URL), sends each request to CRM_URL/__agente, then checks the CRM state and the reply.
// Default: mock model (plumbing only, no cost). REAL_MODEL=1: real gpt-6-luna calls.
// ONLY=1,3 runs a subset. Run from crm/: npx tsx scripts/agent-scenarios.ts
import { closeStore, initializeStore, query } from "../src/store.js";

const url = process.env.CRM_URL ?? "http://localhost:3000";
const token = process.env.CRM_TOKEN ?? "";
const real = process.env.REAL_MODEL === "1";
const only = (process.env.ONLY ?? "").split(",").filter(Boolean).map(Number);
const now = "2026-12-02T10:00:00+01:00";

type P = Record<string, any>;
type Scenario = {
  name: string; user: string; lang: "it" | "en";
  messages: Array<{ role: string; content: string; attachments?: P[] }>;
  check: (reply: string) => Promise<[boolean, string]>;
};

const one = async <T extends P>(sql: string, values: unknown[] = []) => (await query<T>(sql, values))[0];
const props = async (id: string) => (await one<{ properties: P }>(`SELECT properties FROM objects WHERE id = $1`, [id]))?.properties ?? {};
const has = (reply: string, ...needles: string[]) => needles.every((n) => reply.toLowerCase().includes(n.toLowerCase()));
const italianNumber = (n: number) => new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" } as unknown as Intl.NumberFormatOptions).format(n);
const numberIn = (reply: string, n: number) => {
  const plain = reply.replace(/\s/g, "");
  return plain.includes(italianNumber(n).replace(/\s/g, "")) || plain.includes(n.toFixed(2)) || plain.includes(italianNumber(n).replace(/\./g, ""));
};

async function scenarios(): Promise<Scenario[]> {
  const list: Scenario[] = [];
  const active = `(SELECT email FROM crm_users WHERE active)`;

  // 1. Mark as won the only open sales deal of a company (example 1 shape).
  const won = await one<{ id: string; dealname: string; company: string; owner: string }>(`
    SELECT d.id::text, d.properties->>'dealname' AS dealname, c.properties->>'name' AS company, d.properties->>'commerciale' AS owner
    FROM objects c JOIN associations a ON a.from_type = 'companies' AND a.from_id = c.id::text AND a.to_type = 'deals'
    JOIN objects d ON d.type = 'deals' AND d.id = a.to_id::bigint
    WHERE c.type = 'companies' AND d.properties->>'pipeline' = 'default' AND d.properties->>'dealstage' NOT IN ('closedwon', 'closedlost')
      AND d.properties->>'commerciale' IN ${active}
      AND (SELECT count(*) FROM associations x WHERE x.from_type = 'companies' AND x.from_id = c.id::text AND x.to_type = 'deals') = 1
      AND (SELECT count(*) FROM objects y WHERE y.type = 'companies'
        AND regexp_replace(y.properties->>'name', '\\s+S\\.[A-Za-z.]+$', '') = regexp_replace(c.properties->>'name', '\\s+S\\.[A-Za-z.]+$', '')) = 1
    ORDER BY c.id LIMIT 1`);
  if (won) list.push({
    name: "won deal (example 1)", user: won.owner, lang: "it",
    messages: [{ role: "user", content: `La trattativa di ${won.company.replace(/ S\.[a-z.]+$/i, "")} è vinta: abbiamo ricevuto l'ordine firmato.` }],
    check: async (reply) => {
      const deal = await props(won.id);
      const tickets = await query(`SELECT 1 FROM objects WHERE type = 'tickets' AND properties->>'subject' = $1`, [`Avvio fornitura - ${won.dealname}`]);
      return [deal.dealstage === "closedwon" && tickets.length === 1, `stage ${deal.dealstage}, tickets ${tickets.length}, closedate ${deal.closedate}`];
    },
  });

  // 2. Revenue 2025 of a company with revenue (example 2 shape).
  const rich = await one<{ name: string; value: string; owner: string }>(`
    SELECT c.properties->>'name' AS name, c.properties->>'fatturato_2025' AS value, (SELECT email FROM crm_users WHERE active ORDER BY id LIMIT 1) AS owner
    FROM objects c WHERE c.type = 'companies' AND (c.properties->>'fatturato_2025')::numeric > 20000
      AND (SELECT count(*) FROM objects y WHERE y.type = 'companies' AND y.properties->>'name' = c.properties->>'name') = 1
    ORDER BY c.id LIMIT 1`);
  if (rich) list.push({
    name: "revenue 2025 (example 2)", user: rich.owner, lang: "it",
    messages: [{ role: "user", content: `Qual è il fatturato 2025 di ${rich.name}?` }],
    check: async (reply) => [numberIn(reply, Number(rich.value)), `expected ${italianNumber(Number(rich.value))}`],
  });

  // 3. Forbidden: a company with an existing VAT number.
  const vat = await one<{ vat: string; name: string }>(`SELECT properties->>'partita_iva' AS vat, properties->>'name' AS name FROM objects WHERE type = 'companies' AND properties ? 'partita_iva' ORDER BY id LIMIT 1`);
  if (vat) list.push({
    name: "duplicate VAT refused", user: won?.owner ?? "", lang: "it",
    messages: [{ role: "user", content: `Crea l'azienda Officine Test Rossi S.r.l., partita IVA IT ${vat.vat}, sito officinetestrossi.it, Milano.` }],
    check: async (reply) => {
      const created = await query(`SELECT 1 FROM objects WHERE type = 'companies' AND properties->>'name' ILIKE '%Officine Test Rossi%'`);
      return [created.length === 0 && /iva/i.test(reply), `created ${created.length}`];
    },
  });

  // 4. Ambiguous: a company with two open sales deals -> ask, change nothing.
  const amb = await one<{ company: string; ids: string[]; owner: string }>(`
    SELECT c.properties->>'name' AS company, array_agg(d.id::text) AS ids, min(d.properties->>'commerciale') AS owner
    FROM objects c JOIN associations a ON a.from_type = 'companies' AND a.from_id = c.id::text AND a.to_type = 'deals'
    JOIN objects d ON d.type = 'deals' AND d.id = a.to_id::bigint
    WHERE c.type = 'companies' AND d.properties->>'pipeline' = 'default' AND d.properties->>'dealstage' NOT IN ('closedwon', 'closedlost')
    GROUP BY c.id HAVING count(*) = 2 ORDER BY c.id LIMIT 1`);
  if (amb) list.push({
    name: "ambiguous deal -> question", user: amb.owner, lang: "it",
    messages: [{ role: "user", content: `Segna come persa la trattativa di ${amb.company.replace(/ S\.[a-z.]+$/i, "")}.` }],
    check: async (reply) => {
      const stages = await Promise.all(amb.ids.map(async (id) => (await props(id)).dealstage));
      return [!stages.includes("closedlost") && reply.includes("?"), `stages ${stages.join("/")}`];
    },
  });

  // 5. "I miei clienti": count of class A customers followed by a user.
  const follower = await one<{ email: string; n: string }>(`
    WITH f AS (
      SELECT d.properties->>'commerciale' AS email, a.to_id FROM objects d JOIN associations a ON a.from_type = 'deals' AND a.from_id = d.id::text AND a.to_type = 'companies' WHERE d.type = 'deals'
      UNION SELECT t.properties->>'assegnatario', a.to_id FROM objects t JOIN associations a ON a.from_type = 'tickets' AND a.from_id = t.id::text AND a.to_type = 'companies' WHERE t.type = 'tickets')
    SELECT f.email, count(DISTINCT f.to_id)::text AS n FROM f JOIN objects c ON c.id = f.to_id::bigint AND c.properties->>'classe_cliente' = 'A'
    WHERE f.email IN ${active} GROUP BY 1 HAVING count(DISTINCT f.to_id) BETWEEN 1 AND 5 ORDER BY 1 LIMIT 1`);
  if (follower) list.push({
    name: "my class A customers", user: follower.email, lang: "it",
    messages: [{ role: "user", content: "Quanti sono i miei clienti di classe A? Dimmi anche i nomi." }],
    check: async (reply) => [new RegExp(`\\b${follower.n}\\b`).test(reply), `expected ${follower.n}`],
  });

  // 6. Date math: callback task in six months on a contact.
  const person = await one<{ id: string; name: string; company: string }>(`
    SELECT p.id::text, (p.properties->>'firstname') || ' ' || (p.properties->>'lastname') AS name, c.properties->>'name' AS company
    FROM objects p JOIN associations a ON a.from_type = 'contacts' AND a.from_id = p.id::text AND a.to_type = 'companies'
    JOIN objects c ON c.id = a.to_id::bigint
    WHERE p.type = 'contacts' AND (SELECT count(*) FROM objects q WHERE q.type = 'contacts' AND q.properties->>'lastname' = p.properties->>'lastname' AND q.properties->>'firstname' = p.properties->>'firstname') = 1
    ORDER BY p.id LIMIT 1`);
  if (person) list.push({
    name: "task in six months", user: won?.owner ?? "", lang: "it",
    messages: [{ role: "user", content: `Ricordami di richiamare ${person.name} di ${person.company} tra sei mesi.` }],
    check: async () => {
      const tasks = await query<{ properties: P }>(`SELECT o.properties FROM objects o JOIN associations a ON a.from_type = 'tasks' AND a.from_id = o.id::text AND a.to_type = 'contacts' AND a.to_id = $1 WHERE o.type = 'tasks' ORDER BY o.id DESC`, [person.id]);
      const due = String(tasks[0]?.properties.hs_timestamp ?? "");
      return [tasks.length >= 1 && due.startsWith("2027-06-02"), `tasks ${tasks.length}, latest due ${due}`];
    },
  });

  // 7. CSV attachment: two contacts, one on a known company domain (R12).
  const domain = await one<{ domain: string; id: string }>(`SELECT properties->>'domain' AS domain, id::text FROM objects WHERE type = 'companies' AND properties ? 'domain' ORDER BY id DESC LIMIT 1`);
  if (domain) list.push({
    name: "CSV import of contacts", user: won?.owner ?? "", lang: "it",
    messages: [{
      role: "user", content: "Ti allego i contatti conosciuti alla fiera, inseriscili nel CRM.",
      attachments: [{ name: "fiera.csv", content_type: "text/csv", content: `nome;cognome;email;telefono;tipo\nGiulia;Fieratest;giulia.fieratest@${domain.domain};+39 02 1234567;Lead\nPietro;Fieratest;PIETRO.FIERATEST@sconosciuta-fiera.it;333 1234567;Prospect\n` }],
    }],
    check: async () => {
      const rows = await query<{ id: string; properties: P }>(`SELECT id::text, properties FROM objects WHERE type = 'contacts' AND properties->>'lastname' = 'Fieratest'`);
      const giulia = rows.find((r) => r.properties.firstname === "Giulia");
      const linked = giulia ? await query(`SELECT 1 FROM associations WHERE from_type = 'contacts' AND from_id = $1 AND to_type = 'companies' AND to_id = $2`, [giulia.id, domain.id]) : [];
      const stages = rows.map((r) => r.properties.lifecyclestage).sort().join("/");
      return [rows.length === 2 && linked.length === 1 && stages === "lead/opportunity", `contacts ${rows.length}, R12 ${linked.length}, stages ${stages}`];
    },
  });

  // 8. English question -> English answer with the open tickets count.
  const tix = await one<{ name: string; n: string }>(`
    SELECT c.properties->>'name' AS name, count(*)::text AS n FROM objects c
    JOIN associations a ON a.from_type = 'companies' AND a.from_id = c.id::text AND a.to_type = 'tickets'
    JOIN objects t ON t.id = a.to_id::bigint AND t.properties->>'hs_pipeline_stage' <> 'Chiuso'
    WHERE c.type = 'companies' AND (SELECT count(*) FROM objects y WHERE y.type = 'companies' AND y.properties->>'name' = c.properties->>'name') = 1
    GROUP BY c.id HAVING count(*) >= 2 ORDER BY c.id LIMIT 1`);
  if (tix) list.push({
    name: "English: open tickets", user: won?.owner ?? "", lang: "en",
    messages: [{ role: "user", content: `How many open tickets does ${tix.name} have?` }],
    check: async (reply) => [new RegExp(`\\b${tix.n}\\b`).test(reply) && /\b(the|has|open)\b/i.test(reply) && !/\b(ha|sono|aperti)\b/i.test(reply), `expected ${tix.n}, English`],
  });

  // 9. Owner who left the company -> refused.
  const left = await one<{ name: string }>(`SELECT first_name || ' ' || last_name AS name FROM crm_users u WHERE NOT active
    AND NOT EXISTS (SELECT 1 FROM crm_users v WHERE v.active AND v.first_name = u.first_name AND v.last_name = u.last_name) ORDER BY id LIMIT 1`);
  if (left && won) list.push({
    name: "assign to a user who left", user: won.owner, lang: "it",
    messages: [{ role: "user", content: `Assegna la trattativa "${won.dealname}" a ${left.name}.` }],
    check: async () => {
      const deal = await props(won.id);
      return [deal.commerciale === won.owner, `commerciale ${deal.commerciale}`];
    },
  });
  return list;
}

async function main(): Promise<void> {
  await initializeStore();
  const all = await scenarios();
  let failures = 0;
  let spent = 0;
  for (const [index, scenario] of all.entries()) {
    if (only.length && !only.includes(index + 1)) continue;
    const started = performance.now();
    const response = await fetch(`${url}/__agente`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-crm-check-model": real ? "real" : "mock" },
      body: JSON.stringify({ context: { now, user: scenario.user }, messages: scenario.messages }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json() as { reply?: string };
    const ms = Math.round(performance.now() - started);
    const reply = String(body.reply ?? "");
    let ok = response.status === 200 && typeof body.reply === "string" && ms < 60_000;
    let detail = `HTTP ${response.status}`;
    if (real) {
      const [passed, info] = await scenario.check(reply);
      ok &&= passed;
      detail += `, ${info}`;
    }
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${index + 1}. ${scenario.name} (${scenario.lang}, ${ms} ms): ${detail}`);
    console.log(`     > ${scenario.messages.at(-1)!.content}`);
    console.log(`     < ${reply.replace(/\n+/g, " | ")}`);
  }
  if (real) {
    const key = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } }).then((r) => r.json()) as { data?: { usage?: number; limit?: number } };
    spent = key.data?.usage ?? 0;
    console.log(`OpenRouter key usage so far: $${spent.toFixed(4)} of $${key.data?.limit ?? "?"}`);
  }
  await closeStore();
  process.exitCode = failures ? 1 : 0;
}

await main();
