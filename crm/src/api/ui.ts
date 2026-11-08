// Read endpoints for the web UI (/ui-api/*, bearer like every API route): one call per page.
// Writes from the UI go through the public API (records.ts), so moves on the board run R10/R11.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { query } from "../store.js";
import { AgentInputError, runAgent } from "../agent/index.js";
import { openRouterModel } from "../agent/model.js";
import { ApiError } from "./errors.js";

type Props = Record<string, string | undefined>;
type Q = Record<string, string | undefined>;
const PAGE = 50;
const ACTIVITY_TYPES = ["notes", "calls", "emails", "meetings", "tasks"];

// Numeric text only: a property written by hand never breaks a page with a bad cast.
const num = (expr: string) => `(CASE WHEN ${expr} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${expr})::numeric END)`;
// Euro at the fixed management-control rates (R8).
const eur = (p: string) => `${num(`${p}->>'amount'`)} * (CASE upper(coalesce(${p}->>'deal_currency_code','EUR')) WHEN 'USD' THEN 0.92 WHEN 'GBP' THEN 1.17 ELSE 1 END)`;
const won = (p: string) => `((coalesce(${p}->>'pipeline','default') = 'default' AND ${p}->>'dealstage' = 'closedwon') OR (${p}->>'pipeline' = 'Rinnovi' AND ${p}->>'dealstage' = 'Rinnovato'))`;

const page = (q: Q) => Math.max(Number(q.page ?? 1) || 1, 1);
const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

let usersCache: { at: number; byEmail: Map<string, string> } | undefined;
async function userNames(): Promise<Map<string, string>> {
  if (usersCache && Date.now() - usersCache.at < 60_000) return usersCache.byEmail;
  const rows = await query<{ email: string; name: string }>(
    `SELECT lower(email) AS email, trim(first_name || ' ' || last_name) AS name FROM crm_users`);
  usersCache = { at: Date.now(), byEmail: new Map(rows.map((r) => [r.email, r.name])) };
  return usersCache.byEmail;
}
const person = (names: Map<string, string>, email?: string) =>
  email ? { email, name: names.get(email.toLowerCase()) ?? email } : null;

function textOf(type: string, p: Props): string {
  const body = type === "notes" ? p.hs_note_body : type === "calls" ? p.hs_call_body ?? p.hs_call_title
    : type === "emails" ? p.hs_email_text ?? p.hs_email_subject : type === "meetings" ? p.hs_meeting_body ?? p.hs_meeting_title
      : p.hs_task_body ?? p.hs_task_subject;
  return String(body ?? "").replace(/<[^>]+>/g, " ").trim();
}

export function registerUiRoutes(app: FastifyInstance): void {
  app.get("/ui-api/users", async () => {
    const rows = await query(`SELECT id, first_name, last_name, email, active FROM crm_users ORDER BY active DESC, last_name, first_name`);
    return { results: rows };
  });

  app.get("/ui-api/companies", async (request: FastifyRequest<{ Querystring: Q }>) => {
    const q = (request.query.q ?? "").trim();
    const cls = request.query.cls ?? "";
    const values: unknown[] = [q, like(q), cls, (page(request.query) - 1) * PAGE];
    const where = `type = 'companies' AND NOT archived
      AND ($1 = '' OR properties->>'name' ILIKE $2 OR properties->>'domain' ILIKE $2 OR properties->>'city' ILIKE $2
           OR properties->>'partita_iva' = $1 OR properties->>'id_legacy' = $1)`;
    const [rows, classes] = await Promise.all([
      query(`SELECT id::text, properties, count(*) OVER () AS total FROM objects
        WHERE ${where} AND ($3 = '' OR coalesce(properties->>'classe_cliente','') = CASE WHEN $3 = 'none' THEN '' ELSE $3 END)
        ORDER BY ${num("properties->>'fatturato_2025'")} DESC NULLS LAST, properties->>'name', id LIMIT ${PAGE} OFFSET $4`, values),
      query<{ cls: string; n: string }>(`SELECT coalesce(properties->>'classe_cliente','') AS cls, count(*) AS n FROM objects
        WHERE ${where} GROUP BY 1`, values.slice(0, 2)),
    ]);
    return {
      total: Number(rows[0]?.total ?? 0), page: page(request.query), pageSize: PAGE,
      classes: Object.fromEntries(classes.map((c) => [c.cls || "none", Number(c.n)])),
      results: rows.map((r) => ({ id: r.id, ...(r.properties as Props) })),
    };
  });

  app.get("/ui-api/companies/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const id = request.params.id;
    if (!/^\d{1,18}$/.test(id)) throw new ApiError(404, "OBJECT_NOT_FOUND", `Company ${id} does not exist.`);
    const [company] = await query<{ id: string; properties: Props; created_at: Date; updated_at: Date }>(
      `SELECT id::text, properties, created_at, updated_at FROM objects WHERE type = 'companies' AND id = $1 AND NOT archived`, [id]);
    if (!company) throw new ApiError(404, "OBJECT_NOT_FOUND", `Company ${id} does not exist.`);
    const names = await userNames();
    const linked = (toType: string, order: string, limit = 500) => query<{ id: string; properties: Props }>(
      `SELECT o.id::text, o.properties FROM associations a JOIN objects o ON o.type = a.to_type AND o.id = a.to_id::bigint
       WHERE a.from_type = 'companies' AND a.from_id = $1 AND a.to_type = $2 AND NOT o.archived
       GROUP BY o.id ORDER BY ${order} LIMIT ${limit}`, [id, toType]);
    const [contacts, deals, tickets, activities, activityStats] = await Promise.all([
      linked("contacts", "o.properties->>'lastname', o.properties->>'firstname', o.id"),
      linked("deals", "o.properties->>'closedate' DESC NULLS LAST, o.id DESC"),
      linked("tickets", "o.properties->>'createdate' DESC NULLS LAST, o.id DESC", 200),
      query<{ id: string; type: string; properties: Props; via: string | null }>(`
        WITH parents AS (
          SELECT to_type AS t, to_id AS i FROM associations WHERE from_type = 'companies' AND from_id = $1 AND to_type IN ('contacts','deals')
          UNION ALL SELECT 'companies', $1),
        acts AS (
          SELECT a.from_type AS t, a.from_id::bigint AS i, min(p.t || ':' || p.i) AS via FROM parents p
          JOIN associations a ON a.to_type = p.t AND a.to_id = p.i AND a.from_type = ANY($2) GROUP BY 1, 2)
        SELECT o.id::text, o.type, o.properties, acts.via FROM acts JOIN objects o ON o.type = acts.t AND o.id = acts.i
        WHERE NOT o.archived ORDER BY o.properties->>'hs_timestamp' DESC NULLS LAST, o.id DESC LIMIT 60`, [id, ACTIVITY_TYPES]),
      query<{ total: string; y2025: string; last: string | null }>(`
        WITH parents AS (
          SELECT to_type AS t, to_id AS i FROM associations WHERE from_type = 'companies' AND from_id = $1 AND to_type IN ('contacts','deals')
          UNION ALL SELECT 'companies', $1),
        acts AS (SELECT DISTINCT a.from_type AS t, a.from_id::bigint AS i FROM parents p
          JOIN associations a ON a.to_type = p.t AND a.to_id = p.i AND a.from_type = ANY($2))
        SELECT count(*) AS total, count(*) FILTER (WHERE left(o.properties->>'hs_timestamp', 4) = '2025') AS y2025,
          max(o.properties->>'hs_timestamp') AS last
        FROM acts JOIN objects o ON o.type = acts.t AND o.id = acts.i WHERE NOT o.archived`, [id, ACTIVITY_TYPES]),
    ]);
    const contactName = new Map(contacts.map((c) => [`contacts:${c.id}`, [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || c.properties.email || `Contact ${c.id}`]));
    const dealName = new Map(deals.map((d) => [`deals:${d.id}`, d.properties.dealname ?? `Deal ${d.id}`]));
    const rate = (c?: string) => (String(c ?? "EUR").toUpperCase() === "USD" ? 0.92 : String(c ?? "").toUpperCase() === "GBP" ? 1.17 : 1);
    const isWon = (p: Props) => ((p.pipeline ?? "default") === "default" && p.dealstage === "closedwon") || (p.pipeline === "Rinnovi" && p.dealstage === "Rinnovato");
    const revenueDeals = deals
      .filter((d) => isWon(d.properties) && String(d.properties.closedate ?? "").startsWith("2025") && Number.isFinite(Number(d.properties.amount)) && d.properties.amount !== "")
      .map((d) => ({ id: d.id, dealname: d.properties.dealname, closedate: d.properties.closedate, amount: d.properties.amount,
        currency: d.properties.deal_currency_code ?? "EUR", amountEur: Math.round(Number(d.properties.amount) * rate(d.properties.deal_currency_code) * 100) / 100 }));
    const reps = new Map<string, number>();
    for (const d of deals) if (d.properties.commerciale) reps.set(d.properties.commerciale, (reps.get(d.properties.commerciale) ?? 0) + 1);
    const stats = activityStats[0];
    return {
      company: { id: company.id, ...company.properties, createdAt: company.created_at, updatedAt: company.updated_at },
      reps: [...reps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([email, n]) => ({ ...person(names, email)!, deals: n })),
      revenueDeals,
      contacts: contacts.map((c) => ({ id: c.id, ...c.properties })),
      deals: deals.map((d) => ({ id: d.id, ...d.properties, owner: person(names, d.properties.commerciale) })),
      tickets: tickets.map((t) => ({ id: t.id, ...t.properties, assignee: person(names, t.properties.assegnatario) })),
      activityStats: { total: Number(stats?.total ?? 0), in2025: Number(stats?.y2025 ?? 0), last: stats?.last ?? null },
      activities: activities.map((a) => ({
        id: a.id, type: a.type, timestamp: a.properties.hs_timestamp ?? null, idLegacy: a.properties.id_legacy ?? null,
        text: textOf(a.type, a.properties), author: person(names, a.properties.autore ?? a.properties.hubspot_owner_id),
        via: a.via ? { kind: a.via.split(":")[0], id: a.via.split(":")[1], name: contactName.get(a.via) ?? dealName.get(a.via) ?? null } : null,
      })),
    };
  });

  app.get("/ui-api/board", async (request: FastifyRequest<{ Querystring: Q }>) => {
    const pipelineId = request.query.pipeline === "Rinnovi" ? "Rinnovi" : "default";
    const q = (request.query.q ?? "").trim();
    const owner = (request.query.owner ?? "").trim().toLowerCase();
    const [pipeline] = await query<{ label: string; stages: Array<{ id: string; label: string; displayOrder: number; closed?: boolean; probability?: number }> }>(
      `SELECT label, stages FROM pipelines WHERE object_type = 'deals' AND pipeline_id = $1`, [pipelineId]);
    const values = [pipelineId, q, like(q), owner];
    const where = `type = 'deals' AND NOT archived AND coalesce(properties->>'pipeline','default') = $1
      AND ($2 = '' OR properties->>'dealname' ILIKE $3 OR properties->>'id_legacy' = $2)
      AND ($4 = '' OR lower(properties->>'commerciale') = $4)`;
    const [totals, cards, owners] = await Promise.all([
      query<{ stage: string; n: string; eur: string | null }>(
        `SELECT properties->>'dealstage' AS stage, count(*) AS n, round(sum(${eur("properties")}), 2) AS eur FROM objects WHERE ${where} GROUP BY 1`, values),
      query<{ id: string; properties: Props; company_id: string | null; company_name: string | null }>(`
        SELECT d.id::text, d.properties, c.id::text AS company_id, c.properties->>'name' AS company_name FROM (
          SELECT id, properties, row_number() OVER (PARTITION BY properties->>'dealstage'
            ORDER BY properties->>'closedate' DESC NULLS LAST, id DESC) AS rn FROM objects WHERE ${where}) d
        LEFT JOIN LATERAL (SELECT o.id, o.properties FROM associations a JOIN objects o ON o.type = 'companies' AND o.id = a.to_id::bigint
          WHERE a.from_type = 'deals' AND a.from_id = d.id::text AND a.to_type = 'companies' AND NOT o.archived ORDER BY o.id LIMIT 1) c ON TRUE
        WHERE d.rn <= 30`, values),
      query<{ email: string }>(`SELECT DISTINCT lower(properties->>'commerciale') AS email FROM objects
        WHERE type = 'deals' AND NOT archived AND properties->>'commerciale' <> '' ORDER BY 1`),
    ]);
    const names = await userNames();
    const byStage = new Map(totals.map((t) => [t.stage, t]));
    return {
      pipeline: { id: pipelineId, label: pipeline?.label ?? pipelineId },
      owners: owners.map((o) => person(names, o.email)).sort((a, b) => a!.name.localeCompare(b!.name)),
      stages: (pipeline?.stages ?? []).sort((a, b) => a.displayOrder - b.displayOrder).map((s) => ({
        id: s.id, label: s.label, closed: Boolean(s.closed), probability: s.probability ?? null,
        total: Number(byStage.get(s.id)?.n ?? 0), amountEur: Number(byStage.get(s.id)?.eur ?? 0),
        deals: cards.filter((c) => c.properties.dealstage === s.id)
          .sort((a, b) => String(b.properties.closedate ?? "").localeCompare(String(a.properties.closedate ?? "")) || Number(b.id) - Number(a.id))
          .map((c) => ({ id: c.id, ...c.properties, owner: person(names, c.properties.commerciale),
            company: c.company_id ? { id: c.company_id, name: c.company_name } : null })),
      })),
    };
  });

  // What the automations did for one deal (R10 ticket, R11 task), shown after a move on the board.
  app.get("/ui-api/deals/:id/automations", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const id = request.params.id;
    if (!/^\d{1,18}$/.test(id)) return { results: [] };
    const rows = await query<{ id: string; type: string; properties: Props }>(
      `SELECT o.id::text, o.type, o.properties FROM associations a JOIN objects o ON o.type = a.to_type AND o.id = a.to_id::bigint
       WHERE a.from_type = 'deals' AND a.from_id = $1 AND a.to_type IN ('tickets','tasks') AND NOT o.archived
         AND (o.properties->>'subject' LIKE 'Avvio fornitura - %' OR o.properties->>'hs_task_subject' LIKE 'Richiamare: %')
       GROUP BY o.id ORDER BY o.id`, [id]);
    return { results: rows.map((r) => ({ id: r.id, type: r.type, subject: r.properties.subject ?? r.properties.hs_task_subject, due: r.properties.hs_timestamp ?? null })) };
  });

  app.get("/ui-api/dormant", async (request: FastifyRequest<{ Querystring: Q }>) => {
    const q = (request.query.q ?? "").trim();
    const sort = request.query.sort === "name" ? "name" : request.query.sort === "value" ? "value" : "recent";
    const order = sort === "name" ? "c.properties->>'name', c.id" : sort === "value" ? "w.value DESC NULLS LAST, c.id" : "w.last_won DESC NULLS LAST, c.id";
    const rows = await query<{ id: string; properties: Props; won: string; value: string | null; last_won: string | null; rep: string | null; total: string }>(`
      WITH members AS (
        SELECT m.record_id AS id FROM lists l JOIN list_memberships m ON m.list_id = l.id
        WHERE l.name = 'Clienti dormienti' AND NOT l.archived)
      SELECT c.id::text, c.properties, w.won, w.value, w.last_won, w.rep, count(*) OVER () AS total
      FROM members JOIN objects c ON c.type = 'companies' AND c.id = members.id AND NOT c.archived
      LEFT JOIN LATERAL (
        SELECT count(*) AS won, round(sum(${eur("d.properties")}), 2) AS value, max(d.properties->>'closedate') AS last_won,
          (array_agg(d.properties->>'commerciale' ORDER BY d.properties->>'closedate' DESC NULLS LAST))[1] AS rep
        FROM associations a JOIN objects d ON d.type = 'deals' AND d.id = a.to_id::bigint AND NOT d.archived
        WHERE a.from_type = 'companies' AND a.from_id = c.id::text AND a.to_type = 'deals' AND ${won("d.properties")}) w ON TRUE
      WHERE ($1 = '' OR c.properties->>'name' ILIKE $2 OR c.properties->>'city' ILIKE $2 OR c.properties->>'id_legacy' = $1 OR c.properties->>'partita_iva' = $1)
      ORDER BY ${order} LIMIT ${PAGE} OFFSET $3`, [q, like(q), (page(request.query) - 1) * PAGE]);
    // Last activity (any year) for the companies on this page, through their contacts and deals.
    const ids = rows.map((r) => r.id);
    const last = ids.length ? await query<{ company: string; last: string | null }>(`
      WITH parents AS (
        SELECT from_id AS company, to_type AS t, to_id AS i FROM associations WHERE from_type = 'companies' AND from_id = ANY($1) AND to_type IN ('contacts','deals'))
      SELECT p.company, max(o.properties->>'hs_timestamp') AS last FROM parents p
      JOIN associations a ON a.to_type = p.t AND a.to_id = p.i AND a.from_type = ANY($2)
      JOIN objects o ON o.type = a.from_type AND o.id = a.from_id::bigint AND NOT o.archived GROUP BY 1`, [ids, ACTIVITY_TYPES]) : [];
    const lastBy = new Map(last.map((l) => [l.company, l.last]));
    const names = await userNames();
    const [list] = await query<{ id: string; processing_type: string; size: string }>(
      `SELECT l.id::text, l.processing_type, (SELECT count(*) FROM list_memberships m WHERE m.list_id = l.id) AS size
       FROM lists l WHERE l.name = 'Clienti dormienti' AND NOT l.archived ORDER BY l.id LIMIT 1`);
    return {
      list: list ? { id: list.id, name: "Clienti dormienti", processingType: list.processing_type, size: Number(list.size) } : null,
      total: Number(rows[0]?.total ?? 0), page: page(request.query), pageSize: PAGE, sort,
      results: rows.map((r) => ({
        id: r.id, ...r.properties, wonDeals: Number(r.won ?? 0), wonValueEur: r.value === null ? null : Number(r.value),
        lastWon: r.last_won, lastActivity: lastBy.get(r.id) ?? null, rep: person(names, r.rep ?? undefined),
      })),
    };
  });

  app.get("/ui-api/tickets", async (request: FastifyRequest<{ Querystring: Q }>) => {
    const q = (request.query.q ?? "").trim();
    const stage = request.query.stage ?? "";
    const priority = request.query.priority ?? "";
    const values: unknown[] = [q, like(q), stage, priority, (page(request.query) - 1) * PAGE];
    const base = `type = 'tickets' AND NOT archived
      AND ($1 = '' OR properties->>'subject' ILIKE $2 OR properties->>'content' ILIKE $2 OR properties->>'id_legacy' = $1)`;
    const [rows, stages, priorities, pipeline] = await Promise.all([
      query<{ id: string; properties: Props; company_id: string | null; company_name: string | null; total: string }>(`
        SELECT t.id::text, t.properties, c.id::text AS company_id, c.properties->>'name' AS company_name, t.total FROM (
          SELECT id, properties, count(*) OVER () AS total FROM objects
          WHERE ${base} AND ($3 = '' OR properties->>'hs_pipeline_stage' = $3)
            AND ($4 = '' OR coalesce(properties->>'hs_ticket_priority','') = CASE WHEN $4 = 'none' THEN '' ELSE $4 END)
          ORDER BY properties->>'createdate' DESC NULLS LAST, id DESC LIMIT ${PAGE} OFFSET $5) t
        LEFT JOIN LATERAL (SELECT o.id, o.properties FROM associations a JOIN objects o ON o.type = 'companies' AND o.id = a.to_id::bigint
          WHERE a.from_type = 'tickets' AND a.from_id = t.id::text AND a.to_type = 'companies' AND NOT o.archived ORDER BY o.id LIMIT 1) c ON TRUE
        ORDER BY t.properties->>'createdate' DESC NULLS LAST, t.id DESC`, values),
      query<{ k: string; n: string }>(`SELECT coalesce(properties->>'hs_pipeline_stage','') AS k, count(*) AS n FROM objects WHERE ${base}
        AND ($3 = '' OR coalesce(properties->>'hs_ticket_priority','') = CASE WHEN $3 = 'none' THEN '' ELSE $3 END) GROUP BY 1`, [q, like(q), priority]),
      query<{ k: string; n: string }>(`SELECT coalesce(properties->>'hs_ticket_priority','') AS k, count(*) AS n FROM objects WHERE ${base}
        AND ($3 = '' OR properties->>'hs_pipeline_stage' = $3) GROUP BY 1`, [q, like(q), stage]),
      query<{ stages: Array<{ id: string; label: string; displayOrder: number; closed?: boolean }> }>(
        `SELECT stages FROM pipelines WHERE object_type = 'tickets' AND pipeline_id = 'Assistenza'`),
    ]);
    const names = await userNames();
    return {
      total: Number(rows[0]?.total ?? 0), page: page(request.query), pageSize: PAGE,
      stages: (pipeline[0]?.stages ?? []).sort((a, b) => a.displayOrder - b.displayOrder).map((s) => ({ id: s.id, label: s.label, closed: Boolean(s.closed), count: Number(stages.find((x) => x.k === s.id)?.n ?? 0) })),
      priorities: Object.fromEntries(priorities.map((p) => [p.k || "none", Number(p.n)])),
      results: rows.map((r) => ({ id: r.id, ...r.properties, assignee: person(names, r.properties.assegnatario),
        company: r.company_id ? { id: r.company_id, name: r.company_name } : null })),
    };
  });

  app.get("/ui-api/contacts", async (request: FastifyRequest<{ Querystring: Q }>) => {
    const q = (request.query.q ?? "").trim();
    const rows = await query<{ id: string; properties: Props; company_id: string | null; company_name: string | null; total: string }>(`
      SELECT t.id::text, t.properties, c.id::text AS company_id, c.properties->>'name' AS company_name, t.total FROM (
        SELECT id, properties, count(*) OVER () AS total FROM objects WHERE type = 'contacts' AND NOT archived
          AND ($1 = '' OR properties->>'email' ILIKE $2 OR (coalesce(properties->>'firstname','') || ' ' || coalesce(properties->>'lastname','')) ILIKE $2
               OR properties->>'id_legacy' = $1 OR properties->>'phone' ILIKE $2)
        ORDER BY properties->>'lastname', properties->>'firstname', id LIMIT ${PAGE} OFFSET $3) t
      LEFT JOIN LATERAL (SELECT o.id, o.properties FROM associations a JOIN objects o ON o.type = 'companies' AND o.id = a.to_id::bigint
        WHERE a.from_type = 'contacts' AND a.from_id = t.id::text AND a.to_type = 'companies' AND NOT o.archived ORDER BY o.id LIMIT 1) c ON TRUE
      ORDER BY t.properties->>'lastname', t.properties->>'firstname', t.id`, [q, like(q), (page(request.query) - 1) * PAGE]);
    return {
      total: Number(rows[0]?.total ?? 0), page: page(request.query), pageSize: PAGE,
      results: rows.map((r) => ({ id: r.id, ...r.properties, company: r.company_id ? { id: r.company_id, name: r.company_name } : null })),
    };
  });

  // The assistant panel: same agent as /__agente, plus the list of changes it made.
  const model = openRouterModel();
  app.post("/ui-api/assistant", async (request, reply) => {
    const body = (request.body ?? {}) as { messages?: unknown; user?: string };
    try {
      const result = await runAgent({ context: { now: new Date().toISOString(), user: body.user ?? "" }, messages: body.messages }, model,
        (message) => request.log.info(message));
      return { reply: result.reply, actions: result.actions, tools: result.tools };
    } catch (error) {
      if (error instanceof AgentInputError) return reply.code(400).send({ status: "error", message: error.message, category: "VALIDATION_ERROR" });
      throw error;
    }
  });
}
