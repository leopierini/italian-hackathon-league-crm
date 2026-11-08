// Lists (segments) API, 2026-09: /crm/lists/2026-09/... with /crm/v3/lists aliases.
// MANUAL and SNAPSHOT lists keep memberships in `list_memberships`; DYNAMIC lists are evaluated
// from their filterBranch at read time, so they always match the current records.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { db, query, withTransaction, type Db } from "../store.js";
import { ApiError, badRequest, notFound } from "./errors.js";
import { objectTypeIds, resolveObjectType, type ObjectType } from "./schema.js";
import { Sql } from "./search.js";

const prefixes = ["/crm/lists/2026-09", "/crm/v3/lists"];
const processingTypes = ["MANUAL", "DYNAMIC", "SNAPSHOT"];

type ListRow = {
  id: string; name: string; object_type_id: string; processing_type: string; filter_branch: Branch | null;
  archived: boolean; created_at: Date; updated_at: Date; list_version: number; filters_updated_at: Date;
};
type Operation = {
  operationType?: string; operator?: string; value?: unknown; values?: unknown[]; lowerBound?: unknown; upperBound?: unknown;
  includeObjectsWithNoValueSet?: boolean; timestamp?: unknown;
};
type Filter = { filterType?: string; property?: string; operation?: Operation; shouldAccept?: boolean; listId?: string; operator?: string };
type Branch = {
  filterBranchType?: string; filterBranchOperator?: string; filters?: Filter[]; filterBranches?: Branch[];
  objectTypeId?: string; associationTypeId?: number; operator?: string;
};

const listColumns = "id, name, object_type_id, processing_type, filter_branch, archived, created_at, updated_at, list_version, filters_updated_at";

function typeOfList(list: ListRow): ObjectType {
  const type = resolveObjectType(list.object_type_id);
  if (!type) throw badRequest(`Unknown objectTypeId ${list.object_type_id}`);
  return type;
}

function objectTypeIdParam(raw: unknown): string {
  const type = resolveObjectType(String(raw ?? ""));
  if (!type) throw badRequest(`Invalid objectTypeId: ${raw}`, { subCategory: "INVALID_OBJECT_TYPE_ID" });
  return objectTypeIds[type];
}

async function getList(client: Db, listId: string, archived = false): Promise<ListRow> {
  if (!/^\d{1,18}$/.test(listId)) throw notFound(`List ${listId} does not exist.`);
  const [row] = await query<ListRow>(`SELECT ${listColumns} FROM lists WHERE id = $1 AND archived = $2`, [listId, archived], client);
  if (!row) throw notFound(`List ${listId} does not exist.`);
  return row;
}

// ---- filters -> SQL -------------------------------------------------------------------------

const systemColumns: Record<string, string> = {
  hs_object_id: "id", createdate: "created_at", hs_createdate: "created_at", lastmodifieddate: "updated_at", hs_lastmodifieddate: "updated_at",
};

async function propertySql(sql: Sql, alias: string, type: ObjectType, filter: Filter): Promise<string> {
  const name = String(filter.property ?? "");
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw badRequest(`Invalid filter property ${name}`);
  const op = filter.operation ?? {};
  const kind = String(op.operationType ?? "").toUpperCase().replace(/-/g, "_");
  const operator = String(op.operator ?? "").toUpperCase();
  const column = systemColumns[name];
  const text = column === "id" ? `${alias}.id::text` : column ? `${alias}.${column}::text` : `(${alias}.properties->>'${name}')`;
  const known = column ? "TRUE" : `coalesce(${text}, '') <> ''`;
  const withBlank = (clause: string) => (op.includeObjectsWithNoValueSet ? `(${clause} OR NOT ${known})` : `(${known} AND ${clause})`);
  const values = (op.values ?? (op.value === undefined ? [] : [op.value])).map((v) => String(v ?? ""));
  const lowered = sql.param(values.map((v) => v.toLowerCase()));

  if (["IS_KNOWN", "IS_NOT_BLANK"].includes(operator)) return known;
  if (["IS_UNKNOWN", "IS_BLANK"].includes(operator)) return `NOT ${known}`;

  if (kind.startsWith("NUMBER")) {
    const num = column === "id" ? `${alias}.id::numeric` : `crm_num(${text})`;
    const n = (v: unknown) => {
      const parsed = Number(String(v ?? "").trim());
      if (!Number.isFinite(parsed)) throw badRequest(`${v} is not a valid number`);
      return `${sql.param(String(parsed))}::numeric`;
    };
    switch (operator) {
      case "IS_EQUAL_TO": return withBlank(`${num} = ${n(op.value ?? values[0])}`);
      case "IS_NOT_EQUAL_TO": return withBlank(`${num} <> ${n(op.value ?? values[0])}`);
      case "IS_GREATER_THAN": return withBlank(`${num} > ${n(op.value)}`);
      case "IS_GREATER_THAN_OR_EQUAL_TO": return withBlank(`${num} >= ${n(op.value)}`);
      case "IS_LESS_THAN": return withBlank(`${num} < ${n(op.value)}`);
      case "IS_LESS_THAN_OR_EQUAL_TO": return withBlank(`${num} <= ${n(op.value)}`);
      case "IS_BETWEEN": return withBlank(`${num} BETWEEN ${n(op.lowerBound)} AND ${n(op.upperBound)}`);
      case "IS_NOT_BETWEEN": return withBlank(`${num} NOT BETWEEN ${n(op.lowerBound)} AND ${n(op.upperBound)}`);
    }
  }
  if (kind.startsWith("DATETIME") || kind.startsWith("DATE") || kind === "TIME_POINT" || kind === "TIME_RANGED") {
    const ms = column && column !== "id" ? `(extract(epoch FROM ${alias}.${column}) * 1000)` : `crm_ms(${text})`;
    const t = (v: unknown) => {
      const raw = String(v ?? "").trim();
      const parsed = /^-?\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      if (!Number.isFinite(parsed)) throw badRequest(`${v} is not a valid date`);
      return parsed;
    };
    const point = (v: unknown) => `${sql.param(t(v))}::double precision`;
    const value = op.timestamp ?? op.value;
    const dayStart = (v: unknown) => { const d = new Date(t(v)); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
    switch (operator) {
      case "IS_EQUAL_TO": {
        const start = dayStart(value);
        return withBlank(`${ms} >= ${sql.param(start)}::double precision AND ${ms} < ${sql.param(start + 86_400_000)}::double precision`);
      }
      case "IS_BEFORE_DATE": return withBlank(`${ms} < ${sql.param(dayStart(value))}::double precision`);
      case "IS_AFTER_DATE": return withBlank(`${ms} >= ${sql.param(dayStart(value) + 86_400_000)}::double precision`);
      case "IS_BEFORE": return withBlank(`${ms} < ${point(value)}`);
      case "IS_AFTER": return withBlank(`${ms} > ${point(value)}`);
      case "IS_BETWEEN": return withBlank(`${ms} BETWEEN ${point(op.lowerBound)} AND ${point(op.upperBound)}`);
      case "IS_NOT_BETWEEN": return withBlank(`${ms} NOT BETWEEN ${point(op.lowerBound)} AND ${point(op.upperBound)}`);
    }
  }
  if (kind.startsWith("BOOL")) {
    const value = sql.param(String(op.value ?? values[0] ?? "").toLowerCase());
    if (operator === "IS_EQUAL_TO") return withBlank(`lower(${text}) = ${value}`);
    if (operator === "IS_NOT_EQUAL_TO") return withBlank(`lower(${text}) <> ${value}`);
  }
  if (kind.startsWith("ENUMERATION")) {
    // Multi-select values are stored ";"-separated.
    const set = `string_to_array(lower(coalesce(${text}, '')), ';')`;
    switch (operator) {
      case "IS_ANY_OF": case "HAS_EVER_BEEN_ANY_OF": return `${set} && ${lowered}::text[]`;
      case "IS_NONE_OF": case "HAS_NEVER_BEEN_ANY_OF": return withBlank(`NOT (${set} && ${lowered}::text[])`);
      case "IS_EXACTLY": case "HAS_EVER_BEEN_EXACTLY": return `(${set} @> ${lowered}::text[] AND ${set} <@ ${lowered}::text[])`;
      case "IS_NOT_EXACTLY": case "HAS_NEVER_BEEN_EXACTLY": return withBlank(`NOT (${set} @> ${lowered}::text[] AND ${set} <@ ${lowered}::text[])`);
      case "CONTAINS_ALL": case "HAS_EVER_CONTAINED_ALL": return `${set} @> ${lowered}::text[]`;
      case "DOES_NOT_CONTAIN_ALL": case "HAS_NEVER_CONTAINED_ALL": return withBlank(`NOT (${set} @> ${lowered}::text[])`);
    }
  }
  // STRING, MULTISTRING and the fallback for any other type: case-insensitive text matching.
  const lowerText = `lower(${text})`;
  const like = (pattern: (v: string) => string) => {
    const escaped = values.map((v) => pattern(v.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)));
    return `${lowerText} LIKE ANY(${sql.param(escaped)}::text[])`;
  };
  switch (operator) {
    case "IS_EQUAL_TO": case "HAS_EVER_BEEN_EQUAL_TO": case "CONTAINS_EXACTLY": case "IS_ANY_OF": return `${lowerText} = ANY(${lowered}::text[])`;
    case "IS_NOT_EQUAL_TO": case "HAS_NEVER_BEEN_EQUAL_TO": case "DOES_NOT_CONTAIN_EXACTLY": case "IS_NONE_OF": return withBlank(`NOT (${lowerText} = ANY(${lowered}::text[]))`);
    case "CONTAINS": case "HAS_EVER_CONTAINED": return like((v) => `%${v}%`);
    case "DOES_NOT_CONTAIN": case "HAS_NEVER_CONTAINED": return withBlank(`NOT (${like((v) => `%${v}%`)})`);
    case "STARTS_WITH": return like((v) => `${v}%`);
    case "ENDS_WITH": return like((v) => `%${v}`);
  }
  throw badRequest(`Unsupported list filter operation ${kind || "?"} ${operator || "?"} on ${name}`, { subCategory: "UNSUPPORTED_FILTER" });
}

async function filterSql(sql: Sql, alias: string, type: ObjectType, filter: Filter, depth: number): Promise<string> {
  const filterType = String(filter.filterType ?? "PROPERTY").toUpperCase();
  if (filterType === "PROPERTY") return propertySql(sql, alias, type, filter);
  if (filterType === "CONSTANT") return filter.shouldAccept ? "TRUE" : "FALSE";
  if (filterType === "IN_LIST") {
    const list = await getList(db(), String(filter.listId ?? ""));
    const inner = await memberIdsSql(sql, list, depth + 1);
    return `${String(filter.operator ?? "IN_LIST").toUpperCase() === "NOT_IN_LIST" ? "NOT " : ""}${alias}.id IN (${inner})`;
  }
  throw badRequest(`Unsupported list filter type ${filterType}`, { subCategory: "UNSUPPORTED_FILTER" });
}

let aliasCounter = 0;

async function branchSql(sql: Sql, alias: string, type: ObjectType, branch: Branch | undefined, depth: number): Promise<string> {
  if (depth > 8) throw badRequest("List filters are nested too deeply.");
  const branchType = String(branch?.filterBranchType ?? "OR").toUpperCase();
  if (branchType === "ASSOCIATION") {
    const target = resolveObjectType(branch?.objectTypeId);
    if (!target) throw badRequest(`Invalid association objectTypeId ${branch?.objectTypeId}`);
    const inner = `t${++aliasCounter}`;
    const condition = await branchSql(sql, inner, target, { ...branch, filterBranchType: "AND" }, depth + 1);
    return `${alias}.id IN (SELECT a.from_id::bigint FROM associations a JOIN objects ${inner} ON ${inner}.id = a.to_id::bigint
      WHERE a.from_type = ${sql.param(type)} AND a.to_type = ${sql.param(target)} AND ${inner}.archived = FALSE AND ${condition})`;
  }
  const parts: string[] = [];
  for (const f of branch?.filters ?? []) parts.push(await filterSql(sql, alias, type, f, depth));
  for (const b of branch?.filterBranches ?? []) parts.push(await branchSql(sql, alias, type, b, depth + 1));
  const any = parts.length ? `(${parts.join(" OR ")})` : "FALSE";
  const all = parts.length ? `(${parts.join(" AND ")})` : "TRUE";
  switch (branchType) {
    case "AND": return all;
    case "NOT_ALL": return `NOT ${all}`;
    case "NOT_ANY": return `NOT ${any}`;
    case "OR": return any;
    default: throw badRequest(`Unsupported filterBranchType ${branchType}`);
  }
}

// SELECT of the member record ids of a list (live records only).
async function memberIdsSql(sql: Sql, list: ListRow, depth = 0): Promise<string> {
  const type = typeOfList(list);
  if (list.processing_type === "DYNAMIC") {
    const where = await branchSql(sql, "o", type, list.filter_branch ?? undefined, depth);
    return `SELECT o.id FROM objects o WHERE o.type = ${sql.param(type)} AND o.archived = FALSE AND ${where}`;
  }
  return `SELECT m.record_id FROM list_memberships m JOIN objects o ON o.id = m.record_id AND o.archived = FALSE
    WHERE m.list_id = ${sql.param(list.id)}`;
}

async function validateFilters(type: ObjectType, branch: Branch | undefined): Promise<void> {
  if (!branch) return;
  if (typeof branch !== "object") throw badRequest("filterBranch must be an object.");
  const sql = new Sql();
  const where = await branchSql(sql, "o", type, branch, 0);
  // Compile check: a bad filter fails here with 400 instead of on every later read.
  try {
    await query(`SELECT 1 FROM objects o WHERE ${where} LIMIT 0`, sql.values);
  } catch (error) {
    throw badRequest(`Invalid list filters: ${(error as Error).message}`);
  }
}

// ---- output ---------------------------------------------------------------------------------

async function sizeOf(list: ListRow): Promise<number> {
  const sql = new Sql();
  const inner = await memberIdsSql(sql, list);
  const [row] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM (${inner}) x`, sql.values);
  return Number(row?.n ?? 0);
}

async function toApiList(list: ListRow, includeFilters = false): Promise<Record<string, unknown>> {
  const size = await sizeOf(list);
  const out: Record<string, unknown> = {
    listId: String(list.id),
    listVersion: list.list_version,
    createdAt: list.created_at.toISOString(),
    updatedAt: list.updated_at.toISOString(),
    filtersUpdatedAt: list.filters_updated_at.toISOString(),
    processingStatus: "COMPLETE",
    processingType: list.processing_type,
    objectTypeId: list.object_type_id,
    name: list.name,
    size,
    listPermissions: { teamsWithEditAccess: [], usersWithEditAccess: [] },
    membershipSettings: { membershipTeamId: null, includeUnassigned: null },
    additionalProperties: { hs_list_size: String(size), hs_list_reference_count: "0" },
  };
  if (list.archived) out.deletedAt = list.updated_at.toISOString();
  if (includeFilters && list.filter_branch) out.filterBranch = list.filter_branch;
  return out;
}

const bool = (v: unknown) => v === true || String(v).toLowerCase() === "true";

// ---- memberships ----------------------------------------------------------------------------

function idsOf(body: unknown, field?: string): string[] {
  const raw = field ? (body as Record<string, unknown> | undefined)?.[field] : body;
  if (raw === undefined && field) return [];
  if (!Array.isArray(raw)) throw badRequest(field ? `${field} must be an array of record ids.` : "The request body must be an array of record ids.");
  return [...new Set(raw.map((v) => String(v ?? "").trim()))];
}

function assertManual(list: ListRow): void {
  if (list.processing_type === "DYNAMIC") {
    throw new ApiError(400, "VALIDATION_ERROR", `List ${list.id} is a DYNAMIC list: its memberships come from its filters and cannot be edited.`, { subCategory: "LIST_PROCESSING_TYPE_NOT_SUPPORTED" });
  }
}

async function changeMembers(client: PoolClient, list: ListRow, add: string[], remove: string[]) {
  const type = typeOfList(list);
  const valid = (ids: string[]) => ids.filter((id) => /^\d{1,18}$/.test(id));
  const existing = new Set((await query<{ id: string }>(
    `SELECT id::text FROM objects WHERE type = $1 AND archived = FALSE AND id = ANY($2::bigint[])`,
    [type, valid([...add, ...remove])], client)).map((r) => r.id));
  const added = add.length ? (await query<{ record_id: string }>(
    `INSERT INTO list_memberships (list_id, record_id) SELECT $1, unnest($2::bigint[])
     ON CONFLICT DO NOTHING RETURNING record_id::text`, [list.id, add.filter((id) => existing.has(id))], client)).map((r) => r.record_id) : [];
  const removed = remove.length ? (await query<{ record_id: string }>(
    `DELETE FROM list_memberships WHERE list_id = $1 AND record_id = ANY($2::bigint[]) RETURNING record_id::text`,
    [list.id, valid(remove)], client)).map((r) => r.record_id) : [];
  if (added.length || removed.length) await client.query(`UPDATE lists SET updated_at = NOW() WHERE id = $1`, [list.id]);
  const removedSet = new Set(removed);
  return {
    recordIdsMissing: [...add.filter((id) => !existing.has(id)), ...remove.filter((id) => !removedSet.has(id) && !existing.has(id))],
    recordIdsRemoved: removed,
    recordsIdsAdded: add.filter((id) => existing.has(id)),
  };
}

// Lists (with their DYNAMIC memberships evaluated) that contain one record.
async function listsOfRecord(objectTypeId: string, recordId: string) {
  if (!/^\d{1,18}$/.test(recordId)) return [];
  const lists = await query<ListRow>(`SELECT ${listColumns} FROM lists WHERE archived = FALSE AND object_type_id = $1 ORDER BY id`, [objectTypeId]);
  const out: Array<Record<string, unknown>> = [];
  for (const list of lists) {
    const sql = new Sql();
    const text = list.processing_type === "DYNAMIC"
      ? `SELECT CASE WHEN ${sql.param(recordId)}::bigint IN (${await memberIdsSql(sql, list)}) THEN NOW() END AS added`
      : `SELECT m.added_at AS added FROM list_memberships m JOIN objects o ON o.id = m.record_id AND o.archived = FALSE
         WHERE m.list_id = ${sql.param(list.id)} AND m.record_id = ${sql.param(recordId)}::bigint`;
    const [row] = await query<{ added: Date | null }>(text, sql.values);
    if (!row?.added) continue;
    const at = (list.processing_type === "DYNAMIC" ? list.filters_updated_at : row.added).toISOString();
    out.push({ listId: String(list.id), listVersion: list.list_version, isPublicList: true, firstAddedTimestamp: at, lastAddedTimestamp: at });
  }
  return out;
}

// ---- routes ---------------------------------------------------------------------------------

type P = { listId: string; objectTypeId: string; listName: string; recordId: string; sourceListId: string };
type Q = { includeFilters?: string; listIds?: string | string[]; listName?: string; after?: string; before?: string; limit?: string };
type Req = FastifyRequest<{ Params: P; Querystring: Q; Body: Record<string, unknown> | unknown[] | undefined }>;

async function searchLists(body: Record<string, unknown>, mode: "search" | "all") {
  const sql = new Sql();
  const where = ["archived = FALSE"];
  if (body.objectTypeId !== undefined && body.objectTypeId !== null && body.objectTypeId !== "") {
    where.push(`object_type_id = ${sql.param(objectTypeIdParam(body.objectTypeId))}`);
  }
  const types = Array.isArray(body.processingTypes) ? body.processingTypes.map((t) => String(t).toUpperCase()) : [];
  if (types.some((t) => !processingTypes.includes(t))) {
    throw badRequest(`Invalid processingTypes: ${types.join(", ")}`, { subCategory: "INVALID_PROCESSING_TYPE" });
  }
  if (types.length) where.push(`processing_type = ANY(${sql.param(types)}::text[])`);
  const ids = Array.isArray(body.listIds) ? body.listIds.map(String).filter((id) => /^\d{1,18}$/.test(id)) : [];
  if (ids.length) where.push(`id = ANY(${sql.param(ids)}::bigint[])`);
  const text = String(body.query ?? "").trim().toLowerCase();
  if (text) where.push(`lower(name) LIKE ${sql.param(`%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)}`);
  const count = Math.min(Math.max(Number(body.count ?? 20) || 20, 1), 500);
  const offset = mode === "all" ? Math.max(Number(body.after ?? 0) || 0, 0) : Math.max(Number(body.offset ?? 0) || 0, 0);
  const rows = await query<ListRow>(
    `SELECT ${listColumns} FROM lists WHERE ${where.join(" AND ")} ORDER BY id LIMIT ${count + 1} OFFSET ${offset}`, sql.values);
  const [total] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM lists WHERE ${where.join(" AND ")}`, sql.values);
  const page = await Promise.all(rows.slice(0, count).map(async (row) => {
    const list = await toApiList(row);
    delete list.listPermissions;
    delete list.membershipSettings;
    return list;
  }));
  const hasMore = rows.length > count;
  if (mode === "search") return { lists: page, hasMore, offset: offset + page.length, total: Number(total?.n ?? 0) };
  const out: Record<string, unknown> = { results: page, total: Number(total?.n ?? 0) };
  if (hasMore) out.paging = { next: { after: String(offset + count) } };
  return out;
}

async function membershipsPage(list: ListRow, q: Q, joinOrder: boolean) {
  const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 250);
  const sql = new Sql();
  const isDynamic = list.processing_type === "DYNAMIC";
  const inner = isDynamic ? await memberIdsSql(sql, list) : "";
  const added = isDynamic ? sql.param(list.filters_updated_at) + "::timestamptz" : "m.added_at";
  const source = isDynamic
    ? `(${inner}) x`
    : `list_memberships m JOIN objects o ON o.id = m.record_id AND o.archived = FALSE`;
  const idCol = isDynamic ? "x.id" : "m.record_id";
  const scope = isDynamic ? "TRUE" : `m.list_id = ${sql.param(list.id)}`;
  let rows: Array<{ id: string; added: Date }>;
  let next: string | undefined;
  if (joinOrder) {
    const offset = Math.max(Number(q.after ?? 0) || 0, 0);
    rows = await query(`SELECT ${idCol}::text AS id, ${added} AS added FROM ${source} WHERE ${scope}
      ORDER BY ${added}, ${idCol} LIMIT ${limit + 1} OFFSET ${offset}`, sql.values);
    if (rows.length > limit) next = String(offset + limit);
  } else {
    const after = /^\d{1,18}$/.test(q.after ?? "") ? q.after! : "0";
    rows = await query(`SELECT ${idCol}::text AS id, ${added} AS added FROM ${source} WHERE ${scope} AND ${idCol} > ${sql.param(after)}::bigint
      ORDER BY ${idCol} LIMIT ${limit + 1}`, sql.values);
    if (rows.length > limit) next = rows[limit - 1]!.id;
  }
  const out: Record<string, unknown> = {
    results: rows.slice(0, limit).map((r) => ({ recordId: r.id, membershipTimestamp: new Date(r.added).toISOString() })),
    total: await sizeOf(list),
  };
  if (next) out.paging = { next: { after: next } };
  return out;
}

export function registerListRoutes(app: FastifyInstance): void {
  for (const prefix of prefixes) {
    app.post(prefix, async (request: Req) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = String(body.name ?? "").trim();
      if (!name) throw badRequest("name is required.");
      const objectTypeId = objectTypeIdParam(body.objectTypeId);
      const processingType = String(body.processingType ?? "").toUpperCase();
      if (!processingTypes.includes(processingType)) {
        throw badRequest(`processingType must be one of ${processingTypes.join(", ")}.`, { subCategory: "INVALID_PROCESSING_TYPE" });
      }
      const branch = (body.filterBranch ?? null) as Branch | null;
      const type = resolveObjectType(objectTypeId)!;
      await validateFilters(type, branch ?? undefined);
      const list = await withTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lists:name', 0))");
        const [dup] = await query(`SELECT id FROM lists WHERE archived = FALSE AND lower(name) = lower($1)`, [name], client);
        if (dup) throw badRequest(`A list named "${name}" already exists.`, { subCategory: "ILS.DUPLICATE_LIST_NAMES" });
        const [row] = await query<ListRow>(
          `INSERT INTO lists (name, object_type_id, processing_type, filter_branch) VALUES ($1, $2, $3, $4::jsonb) RETURNING ${listColumns}`,
          [name, objectTypeId, processingType, branch ? JSON.stringify(branch) : null], client);
        if (processingType === "SNAPSHOT" && branch) {
          const sql = new Sql();
          const inner = await memberIdsSql(sql, { ...row!, processing_type: "DYNAMIC" });
          await client.query(`INSERT INTO list_memberships (list_id, record_id) SELECT ${sql.param(row!.id)}, id FROM (${inner}) x ON CONFLICT DO NOTHING`, sql.values);
        }
        return row!;
      });
      return { list: await toApiList(list, true) };
    });

    app.get(prefix, async (request: Req) => {
      const ids = (Array.isArray(request.query.listIds) ? request.query.listIds : request.query.listIds ? [request.query.listIds] : [])
        .flatMap((v) => v.split(",")).filter((id) => /^\d{1,18}$/.test(id));
      const rows = ids.length ? await query<ListRow>(`SELECT ${listColumns} FROM lists WHERE archived = FALSE AND id = ANY($1::bigint[]) ORDER BY id`, [ids]) : [];
      return { lists: await Promise.all(rows.map((row) => toApiList(row, bool(request.query.includeFilters)))) };
    });

    app.post(`${prefix}/search`, async (request: Req) => searchLists((request.body ?? {}) as Record<string, unknown>, "search"));
    app.post(`${prefix}/all`, async (request: Req) => searchLists((request.body ?? {}) as Record<string, unknown>, "all"));

    app.get(`${prefix}/object-type-id/:objectTypeId/name/:listName`, async (request: Req) => {
      const objectTypeId = objectTypeIdParam(request.params.objectTypeId);
      const [row] = await query<ListRow>(
        `SELECT ${listColumns} FROM lists WHERE archived = FALSE AND object_type_id = $1 AND lower(name) = lower($2) ORDER BY id LIMIT 1`,
        [objectTypeId, request.params.listName]);
      if (!row) throw notFound(`List with name ${request.params.listName} does not exist for object type ${objectTypeId}.`);
      return { list: await toApiList(row, bool(request.query.includeFilters)) };
    });

    app.get(`${prefix}/:listId`, async (request: Req) => {
      const list = await getList(db(), request.params.listId);
      return { list: await toApiList(list, bool(request.query.includeFilters)) };
    });

    app.delete(`${prefix}/:listId`, async (request: Req, reply) => {
      const list = await getList(db(), request.params.listId);
      await query(`UPDATE lists SET archived = TRUE, updated_at = NOW() WHERE id = $1`, [list.id]);
      return reply.code(204).send();
    });

    app.put(`${prefix}/:listId/restore`, async (request: Req, reply) => {
      const list = await getList(db(), request.params.listId, true);
      await query(`UPDATE lists SET archived = FALSE, updated_at = NOW() WHERE id = $1`, [list.id]);
      return reply.code(204).send();
    });

    app.put(`${prefix}/:listId/update-list-name`, async (request: Req) => {
      const name = String(request.query.listName ?? "").trim();
      if (!name) throw badRequest("listName is required.");
      const list = await withTransaction(async (client) => {
        const current = await getList(client, request.params.listId);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lists:name', 0))");
        const [dup] = await query(`SELECT id FROM lists WHERE archived = FALSE AND lower(name) = lower($1) AND id <> $2`, [name, current.id], client);
        if (dup) throw badRequest(`A list named "${name}" already exists.`, { subCategory: "ILS.DUPLICATE_LIST_NAMES" });
        const [row] = await query<ListRow>(`UPDATE lists SET name = $2, updated_at = NOW() WHERE id = $1 RETURNING ${listColumns}`, [current.id, name], client);
        return row!;
      });
      return { updatedList: await toApiList(list, bool(request.query.includeFilters)) };
    });

    app.put(`${prefix}/:listId/update-list-filters`, async (request: Req) => {
      const list = await getList(db(), request.params.listId);
      const branch = (request.body as Record<string, unknown> | undefined)?.filterBranch as Branch | undefined;
      if (!branch) throw badRequest("filterBranch is required.");
      if (list.processing_type !== "DYNAMIC") throw badRequest(`List ${list.id} is not a DYNAMIC list.`);
      await validateFilters(typeOfList(list), branch);
      const [row] = await query<ListRow>(
        `UPDATE lists SET filter_branch = $2::jsonb, list_version = list_version + 1, filters_updated_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING ${listColumns}`, [list.id, JSON.stringify(branch)]);
      return { updatedList: await toApiList(row!, true) };
    });

    // ---- memberships ----

    app.get(`${prefix}/:listId/memberships`, async (request: Req) => membershipsPage(await getList(db(), request.params.listId), request.query, false));
    app.get(`${prefix}/:listId/memberships/join-order`, async (request: Req) => membershipsPage(await getList(db(), request.params.listId), request.query, true));

    app.put(`${prefix}/:listId/memberships/add`, async (request: Req) => withTransaction(async (client) => {
      const list = await getList(client, request.params.listId);
      assertManual(list);
      return changeMembers(client, list, idsOf(request.body), []);
    }));

    app.put(`${prefix}/:listId/memberships/remove`, async (request: Req) => withTransaction(async (client) => {
      const list = await getList(client, request.params.listId);
      assertManual(list);
      return changeMembers(client, list, [], idsOf(request.body));
    }));

    app.put(`${prefix}/:listId/memberships/add-and-remove`, async (request: Req) => withTransaction(async (client) => {
      const list = await getList(client, request.params.listId);
      assertManual(list);
      return changeMembers(client, list, idsOf(request.body, "recordIdsToAdd"), idsOf(request.body, "recordIdsToRemove"));
    }));

    app.put(`${prefix}/:listId/memberships/add-from/:sourceListId`, async (request: Req, reply) => {
      await withTransaction(async (client) => {
        const list = await getList(client, request.params.listId);
        assertManual(list);
        const source = await getList(client, request.params.sourceListId);
        const sql = new Sql();
        const inner = await memberIdsSql(sql, source);
        await client.query(`INSERT INTO list_memberships (list_id, record_id) SELECT ${sql.param(list.id)}, x.id FROM (${inner}) x(id)
          JOIN objects o ON o.id = x.id AND o.type = ${sql.param(typeOfList(list))} ON CONFLICT DO NOTHING`, sql.values);
        await client.query(`UPDATE lists SET updated_at = NOW() WHERE id = $1`, [list.id]);
      });
      return reply.code(204).send();
    });

    app.delete(`${prefix}/:listId/memberships`, async (request: Req, reply) => {
      const list = await getList(db(), request.params.listId);
      assertManual(list);
      await query(`DELETE FROM list_memberships WHERE list_id = $1`, [list.id]);
      return reply.code(204).send();
    });

    app.get(`${prefix}/records/:objectTypeId/:recordId/memberships`, async (request: Req) => {
      const results = await listsOfRecord(objectTypeIdParam(request.params.objectTypeId), request.params.recordId);
      return { results, total: results.length };
    });

    app.post(`${prefix}/records/memberships/batch/read`, async (request: Req) => {
      const startedAt = new Date().toISOString();
      const inputs = (request.body as Record<string, unknown> | undefined)?.inputs;
      if (!Array.isArray(inputs)) throw badRequest("Request body must contain an inputs array.");
      const results = [];
      for (const input of inputs as Array<{ objectTypeId?: string; recordId?: string }>) {
        const objectTypeId = objectTypeIdParam(input?.objectTypeId);
        const recordId = String(input?.recordId ?? "");
        results.push({ objectTypeId, recordId, recordListMemberships: await listsOfRecord(objectTypeId, recordId) });
      }
      return { status: "COMPLETE", results, startedAt, completedAt: new Date().toISOString() };
    });
  }
}

// Member ids of a list as a SELECT (used by LIST exports).
export async function listMembersSql(sql: Sql, listId: string): Promise<{ text: string; type: ObjectType }> {
  const list = await getList(db(), listId);
  return { text: await memberIdsSql(sql, list), type: typeOfList(list) };
}
