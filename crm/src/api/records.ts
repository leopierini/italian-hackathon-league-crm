// The one write path for CRM records: API routes (single and batch) and the assistant go through
// here, so R7 (unique VAT), R10/R11 (deal automations) and R12 (contact -> company by email
// domain) apply everywhere.
import type { PoolClient } from "pg";
import { db, onReset, query, type Db } from "../store.js";
import { ApiError, conflict, invalidProperties, notFound, type PropertyError } from "./errors.js";
import { lastModifiedName, readOnlyProperties, singular, type ObjectType } from "./schema.js";

export type Row = {
  id: string; type: string; properties: Record<string, unknown>;
  created_at: Date; updated_at: Date; archived: boolean;
};
export type PropertyDef = {
  name: string; label: string; type: string; field_type: string; has_unique_value: boolean;
  options: Array<{ value: string; label: string }>; group_name: string | null; hubspot_defined: boolean;
};
export type AssociationInput = { to: { id: string | number }; types?: Array<{ associationCategory?: string; associationTypeId: number | string }> };

const rowColumns = "id, type, properties, created_at, updated_at, archived";

// ---- caches (property definitions, pipelines), invalidated on reset/migrate/schema writes ----

let propertyCache = new Map<string, Promise<Map<string, PropertyDef>>>();
let pipelineCache = new Map<string, Promise<PipelineRow[]>>();
export function invalidateSchemaCache(): void {
  propertyCache = new Map();
  pipelineCache = new Map();
}
onReset(invalidateSchemaCache);

export function propertyDefs(type: ObjectType): Promise<Map<string, PropertyDef>> {
  let cached = propertyCache.get(type);
  if (!cached) {
    cached = query<PropertyDef>(
      `SELECT name, label, type, field_type, has_unique_value, options, group_name, hubspot_defined
       FROM property_definitions WHERE object_type = $1 AND archived = FALSE`, [type],
    ).then((rows) => new Map(rows.map((row) => [row.name, row])));
    cached.catch(() => propertyCache.delete(type));
    propertyCache.set(type, cached);
  }
  return cached;
}

export type Stage = { id: string; label: string; displayOrder: number; closed?: boolean; probability?: number; metadata?: Record<string, string> };
export type PipelineRow = { pipeline_id: string; label: string; stages: Stage[]; display_order: number; created_at: Date; updated_at: Date; archived: boolean };

export function pipelinesOf(type: ObjectType): Promise<PipelineRow[]> {
  let cached = pipelineCache.get(type);
  if (!cached) {
    cached = query<PipelineRow>(
      `SELECT pipeline_id, label, stages, display_order, created_at, updated_at, archived FROM pipelines
       WHERE object_type = $1 AND archived = FALSE ORDER BY display_order, created_at, pipeline_id`, [type]);
    cached.catch(() => pipelineCache.delete(type));
    pipelineCache.set(type, cached);
  }
  return cached;
}

// ---- output -------------------------------------------------------------------------------

const asString = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === "string" ? value : String(value);

export function toApi(row: Row, type: ObjectType, requested?: string[], defs?: Map<string, PropertyDef>): Record<string, unknown> {
  const created = row.created_at.toISOString();
  const updated = row.updated_at.toISOString();
  const system: Record<string, string> = {
    hs_object_id: String(row.id),
    createdate: asString(row.properties.createdate) ?? created,
    [lastModifiedName(type)]: updated,
  };
  if (["notes", "calls", "emails", "meetings", "tasks"].includes(type)) system.hs_createdate = created;
  const properties: Record<string, string | null> = {};
  if (requested?.length) {
    for (const name of requested) {
      if (name in system) properties[name] = system[name]!;
      else if (row.properties[name] !== undefined && row.properties[name] !== null) properties[name] = asString(row.properties[name]);
      else if (defs?.has(name)) properties[name] = null;
    }
    for (const name of ["createdate", lastModifiedName(type), "hs_object_id"]) properties[name] ??= system[name]!;
  } else {
    for (const [name, value] of Object.entries(row.properties)) properties[name] = asString(value);
    Object.assign(properties, system);
  }
  const out: Record<string, unknown> = { id: String(row.id), properties, createdAt: created, updatedAt: updated, archived: row.archived };
  if (row.archived) out.archivedAt = updated;
  return out;
}

// ---- input normalization ------------------------------------------------------------------

// R7: an Italian VAT number is 11 digits, stored without "IT" and without spaces.
export function normalizeVat(raw: string): string {
  const compact = raw.replace(/[\s.\-/]/g, "").replace(/^it/i, "");
  return /^[0-9]{11}$/.test(compact) ? compact : raw.trim();
}

const validatedEnums = new Set(["lifecyclestage", "hs_ticket_priority", "hs_task_status", "hs_task_priority", "hs_task_type"]);
const pipelineProps = new Set(["pipeline", "dealstage", "hs_pipeline", "hs_pipeline_stage"]);

function toIsoDateTime(value: string): string | null {
  if (/^-?\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export type Changes = { set: Record<string, string>; unset: string[] };

// Validates and normalizes property values against the definitions. Empty values clear the
// property (as in HubSpot). Read-only system properties are ignored.
export async function normalizeInput(type: ObjectType, input: Record<string, unknown> | undefined): Promise<Changes> {
  const defs = await propertyDefs(type);
  const changes: Changes = { set: {}, unset: [] };
  const errors: PropertyError[] = [];
  for (const [name, raw] of Object.entries(input ?? {})) {
    if (readOnlyProperties.has(name)) continue;
    const def = defs.get(name);
    if (!def) {
      errors.push({ name, error: "PROPERTY_DOESNT_EXIST", message: `Property "${name}" does not exist` });
      continue;
    }
    let value = raw === null || raw === undefined ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw).trim();
    if (value === "") {
      changes.unset.push(name);
      continue;
    }
    if (def.type === "number") {
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) {
        errors.push({ name, error: "INVALID_DECIMAL", message: `${value} was not a valid number.` });
        continue;
      }
    } else if (def.type === "datetime" || def.type === "date") {
      const iso = toIsoDateTime(value);
      if (!iso) {
        errors.push({ name, error: "INVALID_DATE", message: `${value} was not a valid date.` });
        continue;
      }
      value = def.type === "date" ? iso.slice(0, 10) : iso;
    } else if (def.type === "bool") {
      const lower = value.toLowerCase();
      if (!["true", "false"].includes(lower)) {
        errors.push({ name, error: "INVALID_BOOLEAN", message: `${value} was not a valid boolean.` });
        continue;
      }
      value = lower;
    } else if (def.type === "enumeration" && def.options.length && !pipelineProps.has(name)) {
      const option = def.options.find((o) => o.value.toLowerCase() === value.toLowerCase());
      if (option) value = option.value;
      else if (validatedEnums.has(name)) {
        errors.push({ name, error: "INVALID_OPTION", message: `${value} was not one of the allowed options: [${def.options.map((o) => o.value).join(", ")}]` });
        continue;
      }
    }
    if (name === "email" && type === "contacts") {
      value = value.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(value)) {
        errors.push({ name, error: "INVALID_EMAIL", message: `Email address ${value} is invalid` });
        continue;
      }
    }
    if (name === "partita_iva") value = normalizeVat(value);
    changes.set[name] = value;
  }
  if (errors.length) throw invalidProperties(errors);
  return changes;
}

// Pipeline and stage: default pipeline when missing, stage ids (labels accepted), stage valid
// for the pipeline. Mutates `merged` and `changes`.
async function applyPipeline(type: ObjectType, merged: Record<string, unknown>, changes: Changes, creating: boolean): Promise<void> {
  const [pipelineProp, stageProp, fallback] = type === "deals" ? ["pipeline", "dealstage", "default"]
    : type === "tickets" ? ["hs_pipeline", "hs_pipeline_stage", "0"] : [];
  if (!pipelineProp || !stageProp) return;
  if (!creating && !(pipelineProp in changes.set) && !(stageProp in changes.set)) return;
  const pipelines = await pipelinesOf(type);
  const wanted = asString(merged[pipelineProp]) ?? fallback!;
  const pipeline = pipelines.find((p) => p.pipeline_id === wanted)
    ?? pipelines.find((p) => p.label.toLowerCase() === wanted.toLowerCase());
  if (!pipeline) {
    throw invalidProperties([{ name: pipelineProp, error: "INVALID_OPTION", message: `${wanted} is not a valid pipeline` }]);
  }
  let stageValue = asString(merged[stageProp]);
  if (!stageValue) stageValue = pipeline.stages.slice().sort((a, b) => a.displayOrder - b.displayOrder)[0]?.id ?? "";
  const stage = pipeline.stages.find((s) => s.id === stageValue)
    ?? pipeline.stages.find((s) => s.label.toLowerCase() === stageValue!.toLowerCase());
  if (!stage) {
    throw invalidProperties([{ name: stageProp, error: "INVALID_OPTION", message: `${stageValue} is not a valid stage of pipeline ${pipeline.pipeline_id}` }]);
  }
  for (const [name, value] of [[pipelineProp, pipeline.pipeline_id], [stageProp, stage.id]] as const) {
    if (merged[name] !== value || creating) {
      merged[name] = value;
      changes.set[name] = value;
      changes.unset = changes.unset.filter((n) => n !== name);
    }
  }
}

// HubSpot: when a deal moves into a closed-won or closed-lost stage, the close date is set to
// today (not between two closed-won or two closed-lost stages). An explicit closedate in the same
// write wins. Today is the Europe/Rome calendar day, stored as midnight UTC like imported dates.
async function applyCloseDate(type: ObjectType, merged: Record<string, unknown>, changes: Changes, before: Record<string, unknown> | null, ctx: Context): Promise<void> {
  if (type !== "deals" || "closedate" in changes.set) return;
  const pipelines = await pipelinesOf(type);
  const outcome = (props: Record<string, unknown> | null) => {
    if (!props) return null;
    const pipeline = pipelines.find((p) => p.pipeline_id === (asString(props.pipeline) ?? "default"));
    const stage = pipeline?.stages.find((s) => s.id === asString(props.dealstage));
    const closed = stage?.closed ?? stage?.metadata?.isClosed === "true";
    if (!stage || !closed) return null;
    return Number(stage.probability ?? stage.metadata?.probability ?? 0) >= 1 ? "won" : "lost";
  };
  const now = outcome(merged);
  if (!now || now === outcome(before)) return;
  const day = new Date((ctx.now ?? new Date()).getTime() + 3_600_000 * romeOffsetHours(ctx.now ?? new Date()));
  const value = `${day.toISOString().slice(0, 10)}T00:00:00.000Z`;
  merged.closedate = value;
  changes.set.closedate = value;
  changes.unset = changes.unset.filter((n) => n !== "closedate");
}

// Europe/Rome offset from UTC in hours (2 in summer time, 1 otherwise).
function romeOffsetHours(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", timeZoneName: "shortOffset" }).formatToParts(at);
  const match = /GMT([+-]\d+)/.exec(parts.find((p) => p.type === "timeZoneName")?.value ?? "");
  return match ? Number(match[1]) : 1;
}

// ---- uniqueness (R7 and contact email) -----------------------------------------------------

const safeName = (name: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new ApiError(400, "VALIDATION_ERROR", `Invalid property name ${name}`);
  return name;
};

export async function uniqueProperties(type: ObjectType): Promise<string[]> {
  const defs = await propertyDefs(type);
  const names = [...defs.values()].filter((d) => d.has_unique_value).map((d) => d.name);
  if (type === "contacts") names.push("email");
  return names;
}

// Serializes writers of the same unique value (advisory lock until commit), then checks.
async function lockValue(client: PoolClient, type: string, name: string, value: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${type}:${name}:${value.toLowerCase()}`]);
}

export async function findByUnique(client: Db, type: ObjectType, name: string, value: string): Promise<Row | null> {
  const column = name === "email" ? `lower(properties->>'email')` : `properties->>'${safeName(name)}'`;
  const compared = name === "email" ? value.toLowerCase() : value;
  const [row] = await query<Row>(
    `SELECT ${rowColumns} FROM objects WHERE type = $1 AND archived = FALSE AND ${column} = $2 ORDER BY id LIMIT 1`,
    [type, compared], client);
  return row ?? null;
}

async function checkUnique(client: PoolClient, type: ObjectType, set: Record<string, string>, selfId?: string): Promise<void> {
  for (const name of await uniqueProperties(type)) {
    const value = set[name];
    if (!value) continue;
    await lockValue(client, type, name, value);
    const existing = await findByUnique(client, type, name, value);
    if (existing && existing.id !== selfId) {
      throw type === "contacts" && name === "email"
        ? conflict(`Contact already exists. Existing ID: ${existing.id}`)
        : conflict(`A ${singular(type)} with ${name} "${value}" already exists. Existing ID: ${existing.id}`, {
          context: { [name]: [value], existingId: [existing.id] },
        });
    }
  }
}

function uniqueViolation(error: unknown): ApiError | null {
  const pgError = error as { code?: string; constraint?: string };
  if (pgError?.code !== "23505") return null;
  if (pgError.constraint === "objects_company_vat_uq") return conflict("A company with this partita_iva already exists.");
  if (pgError.constraint === "objects_contact_email_uq") return conflict("Contact already exists.");
  return conflict("A record with this unique value already exists.");
}

// ---- reads --------------------------------------------------------------------------------

const isId = (id: string) => /^\d{1,18}$/.test(id);

export async function getRow(client: Db, type: ObjectType, id: string, opts: { idProperty?: string; archived?: boolean; forUpdate?: boolean } = {}): Promise<Row | null> {
  if (opts.idProperty && opts.idProperty !== "hs_object_id") {
    return findByUnique(client, type, opts.idProperty, id);
  }
  if (!isId(String(id))) return null;
  const [row] = await query<Row>(
    `SELECT ${rowColumns} FROM objects WHERE type = $1 AND id = $2 AND archived = $3${opts.forUpdate ? " FOR UPDATE" : ""}`,
    [type, id, opts.archived ?? false], client);
  return row ?? null;
}

export async function getRows(type: ObjectType, ids: string[], archived = false): Promise<Row[]> {
  const valid = ids.filter((id) => isId(String(id)));
  if (!valid.length) return [];
  return query<Row>(
    `SELECT ${rowColumns} FROM objects WHERE type = $1 AND id = ANY($2::bigint[]) AND archived = $3`,
    [type, valid, archived]);
}

// ---- associations -------------------------------------------------------------------------

export type AssocType = { from_object_type: string; to_object_type: string; type_id: string; inverse_type_id: string | null; label: string | null; category: string };

export async function associationTypes(fromType: string, toType?: string, client: Db = db()): Promise<AssocType[]> {
  return query<AssocType>(
    `SELECT from_object_type, to_object_type, type_id, inverse_type_id, NULLIF(label, '') AS label, category
     FROM association_types WHERE from_object_type = $1 AND ($2::text IS NULL OR to_object_type = $2)
     ORDER BY type_id::bigint`, [fromType, toType ?? null], client);
}

// The unlabeled HubSpot-defined type of a pair, and its inverse.
export async function defaultAssociation(fromType: string, toType: string, client: Db = db()): Promise<{ typeId: string; inverse: string }> {
  const types = await associationTypes(fromType, toType, client);
  const plain = types.find((t) => t.category === "HUBSPOT_DEFINED" && !t.label) ?? types[0];
  if (plain) return { typeId: plain.type_id, inverse: plain.inverse_type_id ?? plain.type_id };
  throw new ApiError(400, "VALIDATION_ERROR", `No association type between ${fromType} and ${toType}`);
}

// Associates two records with the given type (default when omitted), in both directions. A
// labeled association also carries the default one, as in HubSpot.
export async function associate(client: Db, fromType: string, fromId: string, toType: string, toId: string, typeId?: string): Promise<void> {
  const plain = await defaultAssociation(fromType, toType, client);
  const pairs: Array<[string, string]> = [[plain.typeId, plain.inverse]];
  if (typeId && typeId !== plain.typeId) {
    const types = await associationTypes(fromType, toType, client);
    const chosen = types.find((t) => t.type_id === String(typeId));
    if (!chosen) throw new ApiError(400, "VALIDATION_ERROR", `Association type ${typeId} is not valid from ${fromType} to ${toType}`);
    pairs.push([chosen.type_id, chosen.inverse_type_id ?? chosen.type_id]);
  }
  for (const [forward, backward] of pairs) {
    await client.query(
      `INSERT INTO associations (from_type, from_id, to_type, to_id, type_id)
       VALUES ($1, $2, $3, $4, $5), ($3, $4, $1, $2, $6) ON CONFLICT DO NOTHING`,
      [fromType, String(fromId), toType, String(toId), forward, backward]);
  }
}

export async function associatedIds(client: Db, fromType: string, fromId: string, toType: string): Promise<string[]> {
  const rows = await query<{ to_id: string }>(
    `SELECT DISTINCT to_id FROM associations WHERE from_type = $1 AND from_id = $2 AND to_type = $3`,
    [fromType, String(fromId), toType], client);
  return rows.map((r) => r.to_id);
}

// Resolves create-time `associations` inputs to (toType, toId, typeId), checking targets exist.
async function resolveAssociationInputs(client: Db, type: ObjectType, inputs: AssociationInput[] | undefined) {
  const resolved: Array<{ toType: string; toId: string; typeId: string }> = [];
  for (const input of inputs ?? []) {
    const toId = String(input?.to?.id ?? "");
    for (const t of input?.types?.length ? input.types : [{ associationTypeId: "" }]) {
      const typeId = String(t.associationTypeId ?? "");
      const [info] = await query<AssocType>(
        `SELECT from_object_type, to_object_type, type_id FROM association_types WHERE from_object_type = $1 AND type_id = $2 LIMIT 1`,
        [type, typeId], client);
      if (!info) throw new ApiError(400, "VALIDATION_ERROR", `Association type ${typeId} is not valid for ${type}`);
      const target = await getRow(client, info.to_object_type as ObjectType, toId);
      if (!target) throw new ApiError(400, "VALIDATION_ERROR", `Association target ${info.to_object_type} ${toId} does not exist`);
      resolved.push({ toType: info.to_object_type, toId, typeId });
    }
  }
  return resolved;
}

// ---- automations --------------------------------------------------------------------------

const DAY_MS = 86_400_000;
type Context = { now?: Date };

async function runOnce(client: PoolClient, dealId: string, kind: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO automation_runs (deal_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [dealId, kind]);
  return rowCount === 1;
}

async function insertRow(client: PoolClient, type: string, properties: Record<string, string>): Promise<Row> {
  const [row] = await query<Row>(
    `INSERT INTO objects (type, properties) VALUES ($1, $2::jsonb) RETURNING ${rowColumns}`,
    [type, JSON.stringify(properties)], client);
  return row!;
}

const salesStage = (props: Record<string, unknown> | null) =>
  props && (asString(props.pipeline) ?? "default") === "default" ? asString(props.dealstage) : null;

// R10 (won -> supply kickoff ticket) and R11 (lost -> callback task in 180 days). Only when the
// deal enters the stage through the CRM, once per deal.
async function dealAutomations(client: PoolClient, deal: Row, before: Record<string, unknown> | null, ctx: Context): Promise<void> {
  const stage = salesStage(deal.properties);
  if (!stage || stage === salesStage(before)) return;
  const dealname = asString(deal.properties.dealname) ?? "";
  const now = ctx.now ?? new Date();
  if (stage === "closedwon" && await runOnce(client, deal.id, "closedwon")) {
    const props: Record<string, string> = {
      subject: `Avvio fornitura - ${dealname}`, hs_pipeline: "Assistenza", hs_pipeline_stage: "Aperto",
    };
    const owner = asString(deal.properties.commerciale);
    if (owner) props.assegnatario = owner;
    const ticket = await insertRow(client, "tickets", props);
    await associate(client, "tickets", ticket.id, "deals", deal.id);
    for (const companyId of await associatedIds(client, "deals", deal.id, "companies")) {
      await associate(client, "tickets", ticket.id, "companies", companyId);
    }
  }
  if (stage === "closedlost" && await runOnce(client, deal.id, "closedlost")) {
    const task = await insertRow(client, "tasks", {
      hs_task_subject: `Richiamare: ${dealname}`,
      hs_timestamp: new Date(now.getTime() + 180 * DAY_MS).toISOString(),
      hs_task_status: "NOT_STARTED",
    });
    await associate(client, "tasks", task.id, "deals", deal.id);
  }
}

// R12: a contact without a company whose email domain is a company's domain (main or
// additional) gets associated to that company. Never creates companies.
async function autoAssociateContact(client: PoolClient, contact: Row): Promise<void> {
  const email = asString(contact.properties.email);
  const domain = email?.split("@")[1]?.toLowerCase().trim().replace(/^www\./, "");
  if (!domain) return;
  if ((await associatedIds(client, "contacts", contact.id, "companies")).length) return;
  // Main domain first, then additional domains; oldest company on ties.
  const [company] = await query<{ id: string }>(
    `SELECT id FROM objects WHERE type = 'companies' AND archived = FALSE
       AND crm_domains(properties) @> ARRAY[$1]::text[]
     ORDER BY (crm_domain(properties->>'domain') = $1) DESC, id LIMIT 1`, [domain], client);
  if (company) await associate(client, "contacts", contact.id, "companies", company.id);
}

// ---- writes -------------------------------------------------------------------------------

export async function createRecord(
  client: PoolClient, type: ObjectType, input: Record<string, unknown> | undefined,
  associations?: AssociationInput[], ctx: Context = {},
): Promise<Row> {
  const changes = await normalizeInput(type, input);
  const merged: Record<string, unknown> = { ...changes.set };
  await applyPipeline(type, merged, changes, true);
  await applyCloseDate(type, merged, changes, null, ctx);
  const links = await resolveAssociationInputs(client, type, associations);
  await checkUnique(client, type, changes.set);
  let row: Row;
  try {
    await client.query("SAVEPOINT create_record");
    row = await insertRow(client, type, changes.set);
    await client.query("RELEASE SAVEPOINT create_record");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT create_record");
    throw uniqueViolation(error) ?? error;
  }
  for (const link of links) await associate(client, type, row.id, link.toType, link.toId, link.typeId);
  if (type === "contacts") await autoAssociateContact(client, row);
  if (type === "deals") await dealAutomations(client, row, null, ctx);
  return row;
}

export async function updateRecord(
  client: PoolClient, type: ObjectType, id: string, input: Record<string, unknown> | undefined,
  opts: { idProperty?: string } & Context = {},
): Promise<Row> {
  const current = await getRow(client, type, id, { idProperty: opts.idProperty });
  if (!current) throw notFound(`Object not found. objectId are usually numeric.`, { id: [String(id)] });
  const locked = (await getRow(client, type, current.id, { forUpdate: true }))!;
  const changes = await normalizeInput(type, input);
  const merged: Record<string, unknown> = { ...locked.properties, ...changes.set };
  for (const name of changes.unset) delete merged[name];
  await applyPipeline(type, merged, changes, false);
  await applyCloseDate(type, merged, changes, locked.properties, opts);
  await checkUnique(client, type, changes.set, locked.id);
  let row: Row;
  try {
    await client.query("SAVEPOINT update_record");
    [row] = await query<Row>(
      `UPDATE objects SET properties = (properties || $3::jsonb) - $4::text[], updated_at = NOW()
       WHERE type = $1 AND id = $2 RETURNING ${rowColumns}`,
      [type, locked.id, JSON.stringify(changes.set), changes.unset], client) as [Row];
    await client.query("RELEASE SAVEPOINT update_record");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT update_record");
    throw uniqueViolation(error) ?? error;
  }
  if (type === "contacts" && changes.set.email && changes.set.email !== locked.properties.email) {
    await autoAssociateContact(client, row);
  }
  if (type === "deals") await dealAutomations(client, row, locked.properties, opts);
  return row;
}

// Create or update by a unique property (email for contacts, or any hasUniqueValue property).
export async function upsertRecord(
  client: PoolClient, type: ObjectType, idProperty: string, idValue: string, input: Record<string, unknown> | undefined,
  ctx: Context = {},
): Promise<{ row: Row; created: boolean }> {
  if (idProperty === "hs_object_id") {
    const existing = await getRow(client, type, idValue);
    if (existing) return { row: await updateRecord(client, type, existing.id, input, ctx), created: false };
    return { row: await createRecord(client, type, input, [], ctx), created: true };
  }
  const value = idProperty === "partita_iva" ? normalizeVat(String(idValue)) : String(idValue);
  await lockValue(client, type, idProperty, value);
  const existing = await findByUnique(client, type, idProperty, value);
  if (existing) return { row: await updateRecord(client, type, existing.id, input, ctx), created: false };
  return { row: await createRecord(client, type, { ...input, [idProperty]: value }, [], ctx), created: true };
}

// Archive (soft delete). Associations of an archived record are removed. Missing ids are a no-op.
export async function archiveRecord(client: Db, type: ObjectType, id: string, idProperty?: string): Promise<boolean> {
  const row = await getRow(client, type, id, { idProperty });
  if (!row) return false;
  await client.query(`UPDATE objects SET archived = TRUE, updated_at = NOW() WHERE type = $1 AND id = $2`, [type, row.id]);
  await client.query(
    `DELETE FROM associations WHERE (from_type = $1 AND from_id = $2) OR (to_type = $1 AND to_id = $2)`, [type, row.id]);
  return true;
}
