// The assistant's tools. Every read and write goes through the same service layer as the API
// (records.ts, search.ts, rules.ts), so R7, R10, R11 and R12 apply to the assistant too.
import type { PoolClient } from "pg";
import { db, query, withTransaction } from "../store.js";
import { ApiError } from "../api/errors.js";
import {
  archiveRecord, associate, createRecord, defaultAssociation, findByUnique, getRow, getRows, normalizeVat,
  pipelinesOf, propertyDefs, updateRecord, type AssociationInput, type Row,
} from "../api/records.js";
import { Sql, whereFor } from "../api/search.js";
import { listMembersSql } from "../api/lists.js";
import { objectTypes, resolveObjectType, type ObjectType } from "../api/schema.js";
import { customerClass, isWonDeal, revenueCents, revenueYear } from "../migrate/rules.js";
import {
  dealStage, lifecycleStage, normalizeDomain, normalizeSku, parseLocalDate, parseNumber, romeToIso,
  ticketPriority, ticketStage, toIsoDate,
} from "../migrate/normalize.js";
import type { ToolDef } from "./model.js";

export type AgentContext = { now: Date; user: string; actions: string[] };

export class ToolError extends Error {}

type Props = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const activityTypes = ["notes", "calls", "emails", "meetings"] as const;
const engagementTypes = new Set<string>([...activityTypes, "tasks"]);

// ---- formatting -----------------------------------------------------------------------------

const euroFormat = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" } as unknown as Intl.NumberFormatOptions);
export const euro = (cents: number) => `${euroFormat.format(cents / 100)} €`;
const excerpt = (text: unknown, max = 300) => {
  const value = str(text).replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

export function labelOf(type: string, p: Props): string {
  switch (type) {
    case "companies": return str(p.name);
    case "contacts": return [`${str(p.firstname)} ${str(p.lastname)}`.trim(), p.email ? `<${str(p.email)}>` : ""].filter(Boolean).join(" ");
    case "deals": return str(p.dealname);
    case "tickets": return str(p.subject);
    case "products": return `${str(p.name)}${p.hs_sku ? ` (${str(p.hs_sku)})` : ""}`;
    case "line_items": return str(p.name);
    case "notes": return excerpt(p.hs_note_body, 80);
    case "calls": return str(p.hs_call_title) || excerpt(p.hs_call_body, 80);
    case "emails": return str(p.hs_email_subject) || excerpt(p.hs_email_text, 80);
    case "meetings": return str(p.hs_meeting_title) || excerpt(p.hs_meeting_body, 80);
    case "tasks": return str(p.hs_task_subject);
    default: return "";
  }
}

// Properties shown in search results (the full record comes from get_records).
const summaryProps: Record<ObjectType, string[]> = {
  companies: ["name", "domain", "hs_additional_domains", "city", "state", "partita_iva", "fatturato_2025", "classe_cliente", "id_legacy"],
  contacts: ["firstname", "lastname", "email", "phone", "lifecyclestage", "id_legacy"],
  deals: ["dealname", "amount", "deal_currency_code", "pipeline", "dealstage", "closedate", "commerciale", "id_legacy"],
  tickets: ["subject", "hs_pipeline", "hs_pipeline_stage", "hs_ticket_priority", "assegnatario", "createdate", "closed_date", "id_legacy"],
  products: ["name", "hs_sku", "price"],
  line_items: ["name", "hs_sku", "quantity", "price", "hs_discount_percentage", "amount", "id_legacy"],
  notes: ["hs_note_body", "hs_timestamp", "autore", "id_legacy"],
  calls: ["hs_call_title", "hs_call_body", "hs_timestamp", "autore", "id_legacy"],
  emails: ["hs_email_subject", "hs_email_text", "hs_timestamp", "autore", "id_legacy"],
  meetings: ["hs_meeting_title", "hs_meeting_body", "hs_meeting_start_time", "hs_timestamp", "autore", "id_legacy"],
  tasks: ["hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_priority", "hs_timestamp"],
};

// Words of a free-text query match these properties (each word somewhere, accents ignored).
const textProps: Record<ObjectType, string[]> = {
  companies: ["name", "domain", "hs_additional_domains", "city", "id_legacy", "partita_iva"],
  contacts: ["firstname", "lastname", "email", "phone", "id_legacy"],
  deals: ["dealname", "id_legacy"],
  tickets: ["subject", "content", "id_legacy"],
  products: ["name", "hs_sku", "description"],
  line_items: ["name", "hs_sku", "id_legacy"],
  notes: ["hs_note_body", "id_legacy"],
  calls: ["hs_call_title", "hs_call_body", "id_legacy"],
  emails: ["hs_email_subject", "hs_email_text", "id_legacy"],
  meetings: ["hs_meeting_title", "hs_meeting_body", "id_legacy"],
  tasks: ["hs_task_subject", "hs_task_body"],
};

// The record's name as written (companies, deals, tickets, products, contacts), for exact-name matches.
const nameSql: Partial<Record<ObjectType, string>> = {
  companies: "o.properties->>'name'", deals: "o.properties->>'dealname'", tickets: "o.properties->>'subject'",
  products: "o.properties->>'name'", contacts: "concat_ws(' ', o.properties->>'firstname', o.properties->>'lastname')",
};
const legalForm = String.raw`\s+(s\.?r\.?l\.?s?|s\.?p\.?a|s\.?n\.?c|s\.?a\.?s|s\.?s)\.?$`;
const bareName = (text: string) => fold(text).replace(new RegExp(legalForm, "i"), "").replace(/\s+/g, " ").trim();

function summarize(type: ObjectType, row: Row, extra: string[] = []): Props {
  const out: Props = { id: row.id };
  for (const name of [...summaryProps[type], ...extra]) {
    const value = row.properties[name];
    if (value === undefined || value === null || value === "") continue;
    out[name] = engagementTypes.has(type) && /body|text/.test(name) ? excerpt(value) : value;
  }
  return out;
}

function objectType(raw: unknown): ObjectType {
  const type = resolveObjectType(str(raw));
  if (!type) throw new ToolError(`Unknown object type "${str(raw)}". Use one of: ${objectTypes.join(", ")}.`);
  return type;
}

// Companies associated to each record (shown next to deals, contacts and tickets).
async function companiesOf(type: string, ids: string[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const map = new Map<string, Array<{ id: string; name: string }>>();
  if (!ids.length || type === "companies") return map;
  const rows = await query<{ from_id: string; id: string; name: string }>(
    `SELECT DISTINCT a.from_id, o.id::text AS id, coalesce(o.properties->>'name', '') AS name
     FROM associations a JOIN objects o ON o.type = 'companies' AND o.id = a.to_id::bigint AND o.archived = FALSE
     WHERE a.from_type = $1 AND a.from_id = ANY($2::text[]) AND a.to_type = 'companies'`, [type, ids]);
  for (const row of rows) {
    const list = map.get(row.from_id) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.from_id, list);
  }
  return map;
}

// ---- users ----------------------------------------------------------------------------------

export type CrmUser = { id: string; first_name: string; last_name: string; email: string; manager_id: string; active: boolean };

export async function allUsers(): Promise<CrmUser[]> {
  return query<CrmUser>(`SELECT id, first_name, last_name, email, manager_id, active FROM crm_users ORDER BY last_name, first_name`);
}

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const fullName = (u: CrmUser) => `${u.first_name} ${u.last_name}`.trim();

// An owner reference (email or name) -> the email of an ACTIVE user. People who left follow nothing.
async function resolveOwner(property: string, raw: string): Promise<string> {
  const users = await allUsers();
  if (!users.length) return raw.toLowerCase();
  const value = fold(raw);
  let matches = users.filter((u) => u.email.toLowerCase() === value);
  if (!matches.length && !value.includes("@")) {
    const words = value.split(/\s+/).filter(Boolean);
    matches = users.filter((u) => words.every((w) => fold(fullName(u)).split(/\s+/).some((part) => part === w || part.startsWith(w.replace(/\.$/, "")))));
    const people = new Set(matches.map((u) => fold(fullName(u))));
    if (people.size > 1) {
      throw new ToolError(`"${raw}" matches several users: ${matches.map((u) => `${fullName(u)} <${u.email}>${u.active ? "" : " (left the company)"}`).join(", ")}. Ask which one.`);
    }
    if (matches.some((u) => u.active)) matches = matches.filter((u) => u.active);
  }
  const user = matches[0];
  if (!user) throw new ToolError(`No Brambilla user matches "${raw}" for ${property}. Use list_users to find the right person.`);
  if (!user.active) {
    throw new ToolError(`${fullName(user)} <${user.email}> has left the company (inactive user): people who left follow no deals or tickets, so ${property} cannot be set to them. Ask for an active colleague.`);
  }
  return user.email.toLowerCase();
}

// ---- value preparation (Sinergia-style values accepted) ---------------------------------------

const computedProps = new Set(["fatturato_2025", "classe_cliente"]);
const currencyAliases: Record<string, string> = { "€": "EUR", EURO: "EUR", EUR: "EUR", $: "USD", USD: "USD", DOLLARI: "USD", "£": "GBP", GBP: "GBP", STERLINE: "GBP" };

// Time of day of `now` in Europe/Rome: a bare date for an instant ("tra sei mesi") keeps it, so
// the instant falls on that calendar day both in Rome and in UTC.
function romeTimeOfDay(now: Date): { h: number; mi: number } {
  const [h, mi] = now.toLocaleTimeString("en-GB", { timeZone: "Europe/Rome", hour12: false }).split(":").map(Number);
  return { h: h ?? 12, mi: mi ?? 0 };
}

function toDateValue(type: string, name: string, value: string, now: Date): string {
  if (/^-?\d{10,}$/.test(value)) return value;
  const local = parseLocalDate(value);
  if (!local) {
    if (Number.isFinite(Date.parse(value))) return value;
    throw new ToolError(`${name}: "${value}" is not a valid date.`);
  }
  if (/T.*([+-]\d{2}:?\d{2}|Z)$/i.test(value)) return value;
  // Calendar days (close dates) as midnight UTC like the migration; times are Europe/Rome.
  if (!local.hasTime && (name === "closedate" || type === "date")) return toIsoDate(local)!;
  if (!local.hasTime) return romeToIso({ ...local, ...romeTimeOfDay(now), s: 0, hasTime: true })!;
  return romeToIso(local)!;
}

async function prepare(type: ObjectType, input: unknown, ctx: AgentContext, before: Row | null): Promise<Props> {
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    throw new ToolError("properties must be an object of property name -> value.");
  }
  const defs = await propertyDefs(type);
  const out: Props = {};
  const current = before?.properties ?? {};
  for (const [name, raw] of Object.entries((input ?? {}) as Props)) {
    if (raw === undefined) continue;
    if (computedProps.has(name) && type === "companies") {
      throw new ToolError(`${name} is computed by the CRM from won deals (2025 revenue rule): it is never edited by hand.`);
    }
    if (name === "id_legacy" && before) throw new ToolError("id_legacy is the record's Sinergia code: it is never changed.");
    let value = raw === null ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw).trim();
    const def = defs.get(name);
    if (!def || value === "") {
      out[name] = value;
      continue;
    }
    if (def.type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) {
      const n = parseNumber(value);
      if (n === null) throw new ToolError(`${name}: "${value}" is not a number.`);
      value = String(n);
    } else if (def.type === "datetime" || def.type === "date") {
      value = toDateValue(def.type, name, value, ctx.now);
    }
    switch (name) {
      case "domain":
        if (type === "companies") value = normalizeDomain(value) || value;
        break;
      case "hs_additional_domains":
        value = value.split(/[;,\s]+/).map((d) => normalizeDomain(d)).filter(Boolean).join(";");
        break;
      case "partita_iva": {
        const vat = normalizeVat(value);
        if (!/^\d{11}$/.test(vat)) throw new ToolError(`partita_iva "${value}" is not valid: an Italian VAT number has exactly 11 digits (without IT and spaces).`);
        value = vat;
        break;
      }
      case "email":
        value = value.toLowerCase();
        break;
      case "lifecyclestage":
        if (!def.options.some((o) => o.value === value.toLowerCase())) value = lifecycleStage(value) || value;
        else value = value.toLowerCase();
        break;
      case "hs_sku":
        value = normalizeSku(value) || value;
        break;
      case "deal_currency_code":
        value = currencyAliases[value.toUpperCase()] ?? value.toUpperCase();
        break;
      case "commerciale": case "assegnatario":
        value = await resolveOwner(name, value);
        break;
      case "hs_ticket_priority":
        value = ["LOW", "MEDIUM", "HIGH", "URGENT"].includes(value.toUpperCase()) ? value.toUpperCase() : ticketPriority(value) || value;
        break;
      case "hs_pipeline":
        if (/assistenza/i.test(value)) value = "Assistenza";
        break;
      case "hs_pipeline_stage":
        if (type === "tickets" && !["Aperto", "In lavorazione", "In attesa del cliente", "Chiuso"].includes(value)) value = ticketStage(value) ?? value;
        break;
      case "pipeline":
        if (type === "deals") value = /^(vendite|sales|default|sales pipeline)$/i.test(value) ? "default" : /rinnov|renewal/i.test(value) ? "Rinnovi" : value;
        break;
      case "hs_task_status":
        value = value.toUpperCase().replace(/\s+/g, "_");
        break;
    }
    out[name] = value;
  }

  if (type === "deals" && out.dealstage) {
    const pipelineId = str(out.pipeline || current.pipeline || "default");
    const pipeline = (await pipelinesOf("deals")).find((p) => p.pipeline_id === pipelineId);
    const raw = str(out.dealstage);
    if (!pipeline?.stages.some((s) => s.id === raw)) {
      const mapped = dealStage(raw);
      if (mapped) {
        let stage = mapped.stage;
        if (pipelineId === "Rinnovi" && mapped.pipeline === "sales") {
          stage = stage === "closedwon" ? "Rinnovato" : stage === "closedlost" ? "Non rinnovato" : stage;
        } else if (mapped.pipeline === "renewals" && !out.pipeline) out.pipeline = "Rinnovi";
        out.dealstage = stage;
      }
    }
  }

  if (!before) {
    const user = /@/.test(ctx.user) ? ctx.user.toLowerCase() : "";
    const missing = (name: string) => out[name] === undefined || out[name] === "";
    if (type === "deals") {
      if (missing("commerciale") && user) out.commerciale = user;
      if (!missing("amount") && missing("deal_currency_code")) out.deal_currency_code = "EUR";
    }
    if (type === "tickets") {
      if (missing("hs_pipeline")) out.hs_pipeline = "Assistenza";
      if (missing("assegnatario") && user) out.assegnatario = user;
    }
    if ((activityTypes as readonly string[]).includes(type)) {
      if (missing("autore") && user) out.autore = user;
      if (missing("hs_timestamp")) out.hs_timestamp = ctx.now.toISOString();
    }
    if (type === "tasks" && missing("hs_task_status")) out.hs_task_status = "NOT_STARTED";
  }
  return out;
}

// API errors -> a short message the model can explain to the user.
async function explain(type: ObjectType, error: unknown, input: Props): Promise<string> {
  if (error instanceof ToolError) return error.message;
  if (error instanceof ApiError) {
    if (error.statusCode === 409 && type === "companies") {
      const vat = normalizeVat(str(input.partita_iva));
      const existing = vat ? await findByUnique(db(), "companies", "partita_iva", vat) : null;
      return `Refused by the CRM (409 conflict): partita_iva must be unique and company ${existing ? `"${str(existing.properties.name)}" (id ${existing.id})` : ""} already has partita_iva ${vat}. Nothing was written.`;
    }
    if (error.statusCode === 409 && type === "contacts") {
      return `Refused by the CRM (409 conflict): a contact with email ${str(input.email).toLowerCase()} already exists. ${error.message}. Nothing was written.`;
    }
    return `Refused by the CRM (${error.statusCode} ${error.category}): ${error.message}. Nothing was written.`;
  }
  return `Unexpected error: ${(error as Error)?.message ?? String(error)}. Nothing was written.`;
}

// ---- automation effects (reported to the user) ----------------------------------------------

async function automationKinds(client: PoolClient, dealId: string): Promise<Set<string>> {
  const rows = await query<{ kind: string }>(`SELECT kind FROM automation_runs WHERE deal_id = $1`, [dealId], client);
  return new Set(rows.map((r) => r.kind));
}

async function linkedOf(client: PoolClient, fromType: string, fromId: string, toType: string): Promise<Row[]> {
  return query<Row>(
    `SELECT o.id, o.type, o.properties, o.created_at, o.updated_at, o.archived FROM associations a
     JOIN objects o ON o.type = a.to_type AND o.id = a.to_id::bigint AND o.archived = FALSE
     WHERE a.from_type = $1 AND a.from_id = $2 AND a.to_type = $3 GROUP BY o.id ORDER BY o.id`,
    [fromType, fromId, toType], client);
}

async function effectsOf(client: PoolClient, type: ObjectType, row: Row, kindsBefore: Set<string>): Promise<string[]> {
  const effects: string[] = [];
  if (type === "deals") {
    const after = await automationKinds(client, row.id);
    if (after.has("closedwon") && !kindsBefore.has("closedwon")) {
      const ticket = (await linkedOf(client, "deals", row.id, "tickets")).reverse()
        .find((t) => str(t.properties.subject).startsWith("Avvio fornitura - "));
      if (ticket) {
        const companies = (await linkedOf(client, "tickets", ticket.id, "companies")).map((c) => str(c.properties.name));
        effects.push(`CRM automation (won deal): opened ticket "${str(ticket.properties.subject)}" (id ${ticket.id}) in pipeline Assistenza, stage Aperto, assegnatario ${str(ticket.properties.assegnatario) || "none"}, linked to the deal${companies.length ? ` and to ${companies.join(", ")}` : ""}.`);
      }
    }
    if (after.has("closedlost") && !kindsBefore.has("closedlost")) {
      const task = (await linkedOf(client, "deals", row.id, "tasks")).reverse()
        .find((t) => str(t.properties.hs_task_subject).startsWith("Richiamare: "));
      if (task) effects.push(`CRM automation (lost deal): created task "${str(task.properties.hs_task_subject)}" (id ${task.id}), due ${str(task.properties.hs_timestamp).slice(0, 10)}, status NOT_STARTED, linked to the deal.`);
    }
  }
  return effects;
}

const changedProps = (before: Props, after: Props) => {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (str(before[name]) !== str(after[name])) changes[name] = { from: before[name] ?? null, to: after[name] ?? null };
  }
  return changes;
};

// ---- tools ------------------------------------------------------------------------------------

type Filter = { property?: string; operator?: string; value?: unknown; highValue?: unknown; values?: unknown[] };

async function searchRecords(args: Props, ctx: AgentContext): Promise<unknown> {
  const type = objectType(args.objectType);
  const filters = ((args.filters as Filter[] | undefined) ?? []).map((f) => ({
    propertyName: str(f.property), operator: str(f.operator || "EQ").toUpperCase(),
    value: f.value === undefined ? undefined : str(f.value), highValue: f.highValue === undefined ? undefined : str(f.highValue),
    values: f.values?.map(str),
  }));
  const assoc = args.associatedWith as { objectType?: string; id?: string } | undefined;
  if (assoc?.id) filters.push({ propertyName: `associations.${objectType(assoc.objectType)}`, operator: "EQ", value: str(assoc.id), highValue: undefined, values: undefined });
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
  const sort = args.sort as { property?: string; direction?: string } | undefined;

  const run = async (words: string[], any: boolean) => {
    const sql = new Sql();
    const clauses = [await whereFor(sql, type, filters.length ? { filterGroups: [{ filters }] } : {})];
    let score = "";
    if (words.length) {
      const fields = textProps[type].map((p) => `translate(lower(coalesce(o.properties->>'${p}', '')), 'àáâèéêìíîòóôùúû', 'aaaeeeiiiooouuu')`);
      const perWord = words.map((w) => `(${fields.map((f) => `${f} LIKE ${sql.param(`%${w.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)}`).join(" OR ")})`);
      clauses.push(`(${perWord.join(any ? " OR " : " AND ")})`);
      // Partial matches: only the records matching the most words.
      if (any) score = perWord.map((c) => `(CASE WHEN ${c} THEN 1 ELSE 0 END)`).join(" + ");
    }
    const followedBy = str(args.followedBy).toLowerCase();
    if (followedBy) {
      if (type !== "companies") throw new ToolError("followedBy works only with objectType companies.");
      const p = sql.param(followedBy);
      clauses.push(`o.id IN (
        SELECT a.to_id::bigint FROM objects d JOIN associations a ON a.from_type = 'deals' AND a.from_id = d.id::text AND a.to_type = 'companies'
        WHERE d.type = 'deals' AND d.archived = FALSE AND lower(d.properties->>'commerciale') = ${p}
        UNION
        SELECT a.to_id::bigint FROM objects t JOIN associations a ON a.from_type = 'tickets' AND a.from_id = t.id::text AND a.to_type = 'companies'
        WHERE t.type = 'tickets' AND t.archived = FALSE AND lower(t.properties->>'assegnatario') = ${p})`);
    }
    const listName = str(args.inList);
    if (listName) {
      const [list] = await query<{ id: string }>(`SELECT id::text AS id FROM lists WHERE archived = FALSE AND lower(name) = lower($1) ORDER BY id LIMIT 1`, [listName]);
      if (!list) throw new ToolError(`No list named "${listName}".`);
      const members = await listMembersSql(sql, list.id);
      clauses.push(`o.id IN (${members.text})`);
    }
    const where = clauses.join(" AND ");
    let order = "o.id ASC";
    if (sort?.property && /^[A-Za-z0-9_]+$/.test(sort.property)) {
      const def = (await propertyDefs(type)).get(sort.property);
      const expr = def?.type === "number" ? `crm_num(o.properties->>'${sort.property}')`
        : def?.type === "datetime" || def?.type === "date" ? `crm_ms(o.properties->>'${sort.property}')`
        : `lower(o.properties->>'${sort.property}')`;
      order = `${expr} ${/^desc/i.test(str(sort.direction)) ? "DESC" : "ASC"} NULLS LAST, o.id ASC`;
    }
    const bare = bareName(str(args.text));
    const countValues = [...sql.values];
    const exact = nameSql[type] && bare
      ? `(regexp_replace(translate(lower(regexp_replace(trim(${nameSql[type]}), '${legalForm}', '', 'i')), 'àáâèéêìíîòóôùúû', 'aaaeeeiiiooouuu'), '\\s+', ' ', 'g') = ${sql.param(bare)})`
      : "FALSE";
    if (exact !== "FALSE") order = `${exact} DESC, ${order}`;
    const source = score
      ? `(WITH s AS (SELECT o.*, ${score} AS score FROM objects o WHERE ${where}) SELECT * FROM s WHERE score = (SELECT max(score) FROM s)) o`
      : `objects o WHERE ${where}`;
    const [rows, [count]] = await Promise.all([
      query<Row & { exact: boolean }>(`SELECT o.id, o.type, o.properties, o.created_at, o.updated_at, o.archived, ${exact} AS exact FROM ${source} ORDER BY ${order} LIMIT ${limit}`, sql.values),
      query<{ n: string }>(`SELECT count(*)::text AS n FROM ${source}`, countValues),
    ]);
    return { rows, total: Number(count?.n ?? 0) };
  };

  const stop = new Set(["srl", "s.r.l.", "spa", "s.p.a.", "snc", "s.n.c.", "sas", "s.a.s.", "di", "de", "del", "della", "e", "&", "la", "il", "lo", "the", "and", "of"]);
  const words = fold(str(args.text)).split(/[\s,;]+/).map((w) => w.replace(/^[^a-z0-9@]+|[^a-z0-9@.]+$/g, "")).filter((w) => w && !stop.has(w));
  let result = await run(words, false);
  let note: string | undefined;
  if (!result.total && words.length > 1) {
    const longWords = words.filter((w) => w.length >= 4);
    if (longWords.length) {
      result = await run(longWords, true);
      if (result.total) note = "No record contains all the words of the text: these are the closest (most words in common). They may be different records: check before using one, and say so if none is the one meant.";
    }
  }
  const companies = await companiesOf(type, result.rows.map((r) => r.id));
  const extra = ((args.properties as string[] | undefined) ?? []).map(str);
  return {
    total: result.total,
    ...(note ? { note } : {}),
    ...(result.total > result.rows.length ? { shown: result.rows.length } : {}),
    ...(result.rows.some((r) => r.exact) ? { exactNameMatches: result.rows.filter((r) => r.exact).length } : {}),
    results: result.rows.map((row) => ({
      ...summarize(type, row, extra),
      ...(row.exact ? { exactName: true } : {}),
      ...(companies.get(row.id)?.length ? { companies: companies.get(row.id) } : {}),
    })),
  };
}

// Activities (and tasks) of a record; for a company also those of its contacts and deals.
async function activitiesOf(type: string, id: string): Promise<{ count: number; latest: Props[]; lastDate: string | null }> {
  const rows = await query<Row>(
    `WITH targets AS (
       SELECT $1::text AS t, $2::text AS id
       UNION SELECT to_type, to_id FROM associations WHERE $1 = 'companies' AND from_type = 'companies' AND from_id = $2 AND to_type IN ('contacts', 'deals')
     )
     SELECT DISTINCT ON (o.id) o.id, o.type, o.properties, o.created_at, o.updated_at, o.archived
     FROM associations a JOIN targets x ON a.to_type = x.t AND a.to_id = x.id
     JOIN objects o ON o.type = a.from_type AND o.id = a.from_id::bigint AND o.archived = FALSE
     WHERE a.from_type IN ('notes', 'calls', 'emails', 'meetings', 'tasks')`, [type, id]);
  const sorted = rows.sort((a, b) => str(b.properties.hs_timestamp).localeCompare(str(a.properties.hs_timestamp)));
  const nonTasks = sorted.filter((r) => r.type !== "tasks");
  return {
    count: rows.length,
    lastDate: str(nonTasks[0]?.properties.hs_timestamp) || null,
    latest: sorted.slice(0, 8).map((r) => ({ type: r.type, ...summarize(r.type as ObjectType, r) })),
  };
}

async function getRecords(args: Props): Promise<unknown> {
  const type = objectType(args.objectType);
  const ids = ((args.ids as unknown[] | undefined) ?? []).map(str).filter(Boolean).slice(0, 10);
  if (!ids.length) throw new ToolError("ids is required.");
  const rows = await getRows(type, ids);
  const out: Props[] = [];
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) { out.push({ id, error: "not found (or archived)" }); continue; }
    const properties: Props = {};
    for (const [name, value] of Object.entries(row.properties)) if (value !== null && value !== "") properties[name] = value;
    const linked = await query<{ to_type: string; to_id: string }>(
      `SELECT DISTINCT to_type, to_id FROM associations WHERE from_type = $1 AND from_id = $2`, [type, id]);
    const associations: Props = {};
    for (const toType of [...new Set(linked.map((l) => l.to_type))]) {
      if (engagementTypes.has(toType)) continue;
      const targetRows = await getRows(toType as ObjectType, linked.filter((l) => l.to_type === toType).map((l) => l.to_id));
      const items = targetRows.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 40)
        .map((r) => (toType === "companies" || toType === "contacts" || toType === "products")
          ? { id: r.id, label: labelOf(toType, r.properties) }
          : summarize(toType as ObjectType, r));
      associations[toType] = { count: targetRows.length, items };
    }
    const activities = await activitiesOf(type, id);
    out.push({ id, objectType: type, properties, associations, activities, createdAt: row.created_at.toISOString() });
  }
  return { results: out };
}

type RecordInput = { properties?: Props; associations?: Array<{ objectType?: string; id?: string }>; id?: string };

async function createRecords(args: Props, ctx: AgentContext): Promise<unknown> {
  const type = objectType(args.objectType);
  const records = ((args.records as RecordInput[] | undefined) ?? []).slice(0, 50);
  if (!records.length) throw new ToolError("records is required.");
  const results: Props[] = [];
  for (const record of records) {
    let input: Props = {};
    try {
      input = await prepare(type, record.properties, ctx, null);
      const links: AssociationInput[] = [];
      for (const link of record.associations ?? []) {
        const toType = objectType(link.objectType);
        const { typeId } = await defaultAssociation(type, toType);
        links.push({ to: { id: str(link.id) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] });
      }
      const result = await withTransaction(async (client) => {
        const row = await createRecord(client, type, input, links, { now: ctx.now });
        const effects = await effectsOf(client, type, row, new Set());
        if (type === "contacts") {
          const companies = await linkedOf(client, "contacts", row.id, "companies");
          if (companies.length && !(record.associations ?? []).some((l) => resolveObjectType(str(l.objectType)) === "companies")) {
            effects.push(`CRM automation (email domain): contact associated to company ${companies.map((c) => `"${str(c.properties.name)}" (id ${c.id})`).join(", ")}.`);
          }
        }
        return { row, effects };
      });
      ctx.actions.push(`created ${type} "${labelOf(type, result.row.properties)}" (id ${result.row.id})`);
      results.push({ ok: true, id: result.row.id, properties: summarize(type, result.row), ...(result.effects.length ? { automations: result.effects } : {}) });
    } catch (error) {
      results.push({ ok: false, error: await explain(type, error, input), input: record.properties });
    }
  }
  return { results };
}

async function updateRecords(args: Props, ctx: AgentContext): Promise<unknown> {
  const type = objectType(args.objectType);
  const records = ((args.records as RecordInput[] | undefined) ?? []).slice(0, 50);
  if (!records.length) throw new ToolError("records is required.");
  const results: Props[] = [];
  for (const record of records) {
    let input: Props = {};
    try {
      const result = await withTransaction(async (client) => {
        const before = await getRow(client, type, str(record.id), { forUpdate: true });
        if (!before) throw new ToolError(`${type} ${str(record.id)} not found.`);
        input = await prepare(type, record.properties, ctx, before);
        if (!Object.keys(input).length) throw new ToolError("No properties to change.");
        const kinds = type === "deals" ? await automationKinds(client, before.id) : new Set<string>();
        const row = await updateRecord(client, type, before.id, input, { now: ctx.now });
        return { row, changes: changedProps(before.properties, row.properties), effects: await effectsOf(client, type, row, kinds) };
      });
      const changed = Object.entries(result.changes).map(([k, v]) => `${k}: ${str(v.from) || "(empty)"} -> ${str(v.to) || "(empty)"}`).join(", ");
      ctx.actions.push(`updated ${type} "${labelOf(type, result.row.properties)}" (id ${result.row.id})${changed ? `: ${changed}` : " (no change)"}`);
      results.push({ ok: true, id: result.row.id, label: labelOf(type, result.row.properties), changed: result.changes, ...(result.effects.length ? { automations: result.effects } : {}) });
    } catch (error) {
      results.push({ ok: false, id: record.id, error: await explain(type, error, input) });
    }
  }
  return { results };
}

async function associateRecords(args: Props, ctx: AgentContext): Promise<unknown> {
  const fromType = objectType(args.fromObjectType);
  const toType = objectType(args.toObjectType);
  const fromId = str(args.fromId);
  const toIds = ((args.toIds as unknown[] | undefined) ?? []).map(str).filter(Boolean);
  const remove = str(args.action).toLowerCase() === "remove";
  const results: Props[] = [];
  for (const toId of toIds) {
    try {
      await withTransaction(async (client) => {
        const from = await getRow(client, fromType, fromId);
        const to = await getRow(client, toType, toId);
        if (!from) throw new ToolError(`${fromType} ${fromId} not found.`);
        if (!to) throw new ToolError(`${toType} ${toId} not found.`);
        if (remove) {
          const { rowCount } = await client.query(
            `DELETE FROM associations WHERE (from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4)
               OR (from_type = $3 AND from_id = $4 AND to_type = $1 AND to_id = $2)`, [fromType, fromId, toType, toId]);
          if (!rowCount) throw new ToolError("These records were not associated.");
        } else {
          await associate(client, fromType, fromId, toType, toId);
        }
        ctx.actions.push(`${remove ? "removed association" : "associated"} ${fromType} "${labelOf(fromType, from.properties)}" ${remove ? "from" : "to"} ${toType} "${labelOf(toType, to.properties)}"`);
      });
      results.push({ ok: true, toId });
    } catch (error) {
      results.push({ ok: false, toId, error: await explain(toType, error, {}) });
    }
  }
  return { results };
}

async function archiveRecords(args: Props, ctx: AgentContext): Promise<unknown> {
  const type = objectType(args.objectType);
  const ids = ((args.ids as unknown[] | undefined) ?? []).map(str).filter(Boolean).slice(0, 20);
  const results: Props[] = [];
  for (const id of ids) {
    const row = await getRow(db(), type, id);
    if (!row) { results.push({ ok: false, id, error: "not found" }); continue; }
    await withTransaction((client) => archiveRecord(client, type, id));
    ctx.actions.push(`archived ${type} "${labelOf(type, row.properties)}" (id ${id})`);
    results.push({ ok: true, id, label: labelOf(type, row.properties) });
  }
  return { results };
}

const centsOf = (amount: unknown, currency: unknown) => {
  const rate: Record<string, number> = { EUR: 1, USD: 0.92, GBP: 1.17 };
  return Math.round(Number(amount) * 100 * (rate[str(currency || "EUR").toUpperCase()] ?? 1));
};

// Revenue of a company in a year with the R8 rule (same code as the migration).
async function companyRevenue(args: Props): Promise<unknown> {
  const ids = ((args.companyIds as unknown[] | undefined) ?? []).map(str).filter(Boolean).slice(0, 50);
  const year = Number(args.year ?? revenueYear) || revenueYear;
  const companies = await getRows("companies", ids);
  const results: Props[] = [];
  let totalCents = 0;
  for (const id of ids) {
    const company = companies.find((c) => c.id === id);
    if (!company) { results.push({ companyId: id, error: "company not found" }); continue; }
    const dealIds = (await query<{ to_id: string }>(
      `SELECT DISTINCT to_id FROM associations WHERE from_type = 'companies' AND from_id = $1 AND to_type = 'deals'`, [id])).map((r) => r.to_id);
    const deals = await getRows("deals", dealIds);
    const cents = revenueCents(deals.map((d) => d.properties), year);
    totalCents += cents;
    const counted = deals.filter((d) => isWonDeal(d.properties) && new Date(str(d.properties.closedate)).getUTCFullYear() === year
      && d.properties.amount !== undefined && d.properties.amount !== "");
    results.push({
      companyId: id, company: str(company.properties.name), year,
      revenue_eur: cents / 100, revenue_formatted: euro(cents),
      ...(year === revenueYear ? { classe_cliente: customerClass(cents) || "(none: revenue zero or negative)", stored_fatturato_2025: company.properties.fatturato_2025 ?? null } : {}),
      won_deals_in_year: counted.map((d) => ({
        id: d.id, dealname: d.properties.dealname, amount: d.properties.amount, currency: d.properties.deal_currency_code ?? "EUR",
        eur: euro(centsOf(d.properties.amount, d.properties.deal_currency_code)), closedate: str(d.properties.closedate).slice(0, 10),
        pipeline: d.properties.pipeline, kind: Number(d.properties.amount) < 0 ? "storno (subtracted)" : "won",
      })),
    });
  }
  return { rule: "Won deals (closedwon in Vendite, Rinnovato in Rinnovi) closed in the year and associated to the company, minus storni (negative amounts) of the same year; USD x 0.92, GBP x 1.17; total rounded to the cent.", results, ...(ids.length > 1 ? { total_eur: totalCents / 100, total_formatted: euro(totalCents) } : {}) };
}

async function listUsers(args: Props): Promise<unknown> {
  const users = await allUsers();
  const words = fold(str(args.text)).split(/\s+/).filter(Boolean);
  const byId = new Map(users.map((u) => [u.id, u]));
  const matches = users.filter((u) => (!args.activeOnly || u.active) && words.every((w) => fold(`${fullName(u)} ${u.email}`).includes(w)));
  return {
    total: matches.length,
    users: matches.slice(0, 100).map((u) => ({
      name: fullName(u), email: u.email, active: u.active,
      manager: byId.get(u.manager_id) ? `${fullName(byId.get(u.manager_id)!)} <${byId.get(u.manager_id)!.email}>` : null,
    })),
  };
}

const weekdays = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

// Calendar arithmetic on the Europe/Rome day of `base` (default: now).
export function addToDate(base: Date, days = 0, months = 0, years = 0): { date: string; weekday: string; formatted: string } {
  const local = new Date(base.toLocaleString("sv-SE", { timeZone: "Europe/Rome" }).replace(" ", "T") + "Z");
  const y = local.getUTCFullYear() + years;
  const m = local.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(y, m, Math.min(local.getUTCDate(), lastDay)) + days * 86_400_000);
  const iso = target.toISOString().slice(0, 10);
  return { date: iso, weekday: weekdays[target.getUTCDay()]!, formatted: `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` };
}

async function dateMath(args: Props, ctx: AgentContext): Promise<unknown> {
  const base = args.base ? new Date(toDateValue("datetime", "base", str(args.base), ctx.now)) : ctx.now;
  if (!Number.isFinite(base.getTime())) throw new ToolError("base is not a valid date.");
  return addToDate(base, Number(args.days ?? 0) || 0, Number(args.months ?? 0) || 0, Number(args.years ?? 0) || 0);
}

// ---- registry -----------------------------------------------------------------------------------

const typeEnum = { type: "string", enum: [...objectTypes] };
const idList = { type: "array", items: { type: "string" } };

export const toolDefs: ToolDef[] = [
  {
    type: "function", function: {
      name: "search_records",
      description: "Find CRM records. Returns total and up to `limit` results with their main properties (and associated companies for deals, contacts, tickets). `text` matches every word in names/titles/emails/domains/id_legacy (accents ignored). Use filters for exact conditions.",
      parameters: {
        type: "object", properties: {
          objectType: typeEnum,
          text: { type: "string", description: "Free text, e.g. a company name, a person's name, an email, a deal title." },
          filters: {
            type: "array", description: "Conditions, all must hold (AND).", items: {
              type: "object", properties: {
                property: { type: "string" },
                operator: { type: "string", enum: ["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IN", "NOT_IN", "HAS_PROPERTY", "NOT_HAS_PROPERTY", "CONTAINS_TOKEN"] },
                value: { type: "string" }, highValue: { type: "string", description: "Upper bound for BETWEEN." },
                values: { type: "array", items: { type: "string" }, description: "For IN / NOT_IN." },
              }, required: ["property", "operator"],
            },
          },
          associatedWith: { type: "object", description: "Only records associated to this record (e.g. the deals of a company).", properties: { objectType: typeEnum, id: { type: "string" } }, required: ["objectType", "id"] },
          followedBy: { type: "string", description: "companies only: email of a user; keeps the companies they follow (deals where they are commerciale or tickets where they are assegnatario). Use it for 'my customers'." },
          inList: { type: "string", description: "Only members of the list with this name, e.g. 'Clienti dormienti'." },
          properties: { type: "array", items: { type: "string" }, description: "Extra properties to return." },
          sort: { type: "object", properties: { property: { type: "string" }, direction: { type: "string", enum: ["ASC", "DESC"] } } },
          limit: { type: "integer", description: "Default 20, max 100." },
        }, required: ["objectType"],
      },
    },
  },
  {
    type: "function", function: {
      name: "get_records",
      description: "Read up to 10 records in full: all properties, associated records (companies, contacts, deals, tickets, line items...) and their activities (count, latest 8, last activity date; for a company also those of its contacts and deals).",
      parameters: { type: "object", properties: { objectType: typeEnum, ids: idList }, required: ["objectType", "ids"] },
    },
  },
  {
    type: "function", function: {
      name: "create_records",
      description: "Create records (each one separately; one failure does not stop the others). The CRM applies its rules: unique partita_iva (409), unique contact email, automatic association of contacts by email domain, won/lost deal automations. Defaults when omitted: deals commerciale = current user, currency EUR; tickets pipeline Assistenza, stage Aperto, assegnatario = current user; notes/calls/emails/meetings autore = current user and hs_timestamp = now; tasks status NOT_STARTED. Sinergia-style values are accepted (1.234,56; dd/mm/yyyy; Vinta/Persa; Alta/Urgente; Lead/Prospect/Cliente/Ex cliente).",
      parameters: {
        type: "object", properties: {
          objectType: typeEnum,
          records: {
            type: "array", items: {
              type: "object", properties: {
                properties: { type: "object", description: "Property name -> value." },
                associations: { type: "array", items: { type: "object", properties: { objectType: typeEnum, id: { type: "string" } }, required: ["objectType", "id"] } },
              }, required: ["properties"],
            },
          },
        }, required: ["objectType", "records"],
      },
    },
  },
  {
    type: "function", function: {
      name: "update_records",
      description: "Change properties of existing records by id. Returns exactly what changed (from -> to) and what the CRM automations did (e.g. the ticket opened when a deal is won, the callback task when it is lost). An empty string clears a property.",
      parameters: {
        type: "object", properties: {
          objectType: typeEnum,
          records: { type: "array", items: { type: "object", properties: { id: { type: "string" }, properties: { type: "object" } }, required: ["id", "properties"] } },
        }, required: ["objectType", "records"],
      },
    },
  },
  {
    type: "function", function: {
      name: "associate_records",
      description: "Add or remove associations between one record and one or more others (both directions).",
      parameters: {
        type: "object", properties: {
          action: { type: "string", enum: ["add", "remove"] },
          fromObjectType: typeEnum, fromId: { type: "string" }, toObjectType: typeEnum, toIds: idList,
        }, required: ["action", "fromObjectType", "fromId", "toObjectType", "toIds"],
      },
    },
  },
  {
    type: "function", function: {
      name: "archive_records",
      description: "Delete (archive) records by id. Only when the user explicitly asks to delete those specific records.",
      parameters: { type: "object", properties: { objectType: typeEnum, ids: idList }, required: ["objectType", "ids"] },
    },
  },
  {
    type: "function", function: {
      name: "company_revenue",
      description: "Revenue (fatturato) of companies in a year with Brambilla's rule, computed live from their deals: won deals closed in that year minus storni, USD/GBP converted, rounded to the cent; for 2025 also the customer class. Always use this for revenue questions, never add amounts yourself.",
      parameters: { type: "object", properties: { companyIds: idList, year: { type: "integer", description: "Default 2025." } }, required: ["companyIds"] },
    },
  },
  {
    type: "function", function: {
      name: "list_users",
      description: "Brambilla users (from Sinergia): name, email, active or left the company, manager. Use it to turn a colleague's name into an email for commerciale/assegnatario.",
      parameters: { type: "object", properties: { text: { type: "string", description: "Part of a name or email." }, activeOnly: { type: "boolean" } } },
    },
  },
  {
    type: "function", function: {
      name: "date_math",
      description: "Calendar arithmetic: base date (default now) plus days/months/years. Returns the date (YYYY-MM-DD), weekday and dd/mm/yyyy.",
      parameters: { type: "object", properties: { base: { type: "string" }, days: { type: "integer" }, months: { type: "integer" }, years: { type: "integer" } } },
    },
  },
];

const handlers: Record<string, (args: Props, ctx: AgentContext) => Promise<unknown>> = {
  search_records: searchRecords,
  get_records: getRecords,
  create_records: createRecords,
  update_records: updateRecords,
  associate_records: associateRecords,
  archive_records: archiveRecords,
  company_revenue: companyRevenue,
  list_users: listUsers,
  date_math: dateMath,
};

export const writeTools = new Set(["create_records", "update_records", "associate_records", "archive_records"]);

export async function runTool(name: string, rawArgs: string, ctx: AgentContext): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) return { error: `Unknown tool ${name}.` };
  let args: Props;
  try {
    args = rawArgs?.trim() ? JSON.parse(rawArgs) as Props : {};
  } catch {
    return { error: "Arguments are not valid JSON." };
  }
  try {
    return await handler(args, ctx);
  } catch (error) {
    if (error instanceof ToolError) return { error: error.message };
    if (error instanceof ApiError) return { error: `${error.statusCode} ${error.category}: ${error.message}` };
    return { error: `Unexpected error: ${(error as Error)?.message ?? String(error)}` };
  }
}
