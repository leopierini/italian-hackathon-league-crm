import { analyzeStore, resetStore, withTransaction } from "../store.js";
import { downloadExport, readExport } from "./export.js";
import { copyModel, createStaticList } from "./load.js";
import { buildActivities, buildCompanies, buildContacts, buildDeals, buildProducts, buildTickets, Model } from "./model.js";
import { applyRevenueAndDormant, dormantListName } from "./rules.js";
import { createBrambillaSchema } from "./schema.js";
import { UserDirectory } from "./users.js";

type Log = (message: string) => void;

export async function runMigration(exportUrl: string, log: Log): Promise<void> {
  const started = performance.now();
  let phase = started;
  const step = (name: string) => {
    const now = performance.now();
    log(`migrate ${name}: ${Math.round(now - phase)} ms`);
    phase = now;
  };

  const zip = await downloadExport(exportUrl);
  step(`download ${zip.byteLength} bytes`);
  const data = readExport(zip);
  step(`parse ${Object.entries(data).map(([name, rows]) => `${name}=${rows.length}`).join(" ")}`);

  const users = new UserDirectory(data.utenti);
  const model = new Model();
  const createdAt = new Map<number, string>();
  const companies = buildCompanies(data.aziende, model);
  const contacts = buildContacts(data.contatti, companies, model);
  const products = buildProducts(data.listino, model);
  const deals = buildDeals(data, companies, contacts, products, users, model);
  buildTickets(data.ticket, companies, contacts, users, model, createdAt);
  buildActivities(data.attivita, contacts, deals, users, model);
  const dormant = applyRevenueAndDormant(model);
  const types = ["companies", "contacts", "deals", "products", "line_items", "tickets", "notes", "calls", "emails", "meetings"];
  step(`model ${types.map((t) => `${t}=${model.count(t)}`).join(" ")} associations=${model.assocs.length} ${JSON.stringify(model.stats)}`);

  await resetStore();
  step("reset");
  await withTransaction(async (client) => {
    await createBrambillaSchema(client);
    step("schema");
    await copyModel(client, model, createdAt, step);
    await createStaticList(client, dormantListName, "0-2", dormant);
    await client.query(
      `INSERT INTO crm_users (id, first_name, last_name, email, manager_id, active)
       SELECT x.id, x."firstName", x."lastName", x.email, x."managerId", x.active
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, "firstName" text, "lastName" text, email text, "managerId" text, active boolean)
       ON CONFLICT (id) DO NOTHING`, [JSON.stringify([...users.byId.values()])]);
    step("list and users");
  });
  step("commit");
  // Fresh planner statistics, so searches right after the migration use the indexes.
  await analyzeStore();
  step("analyze");
  log(`migrate total: ${Math.round(performance.now() - started)} ms`);
}
