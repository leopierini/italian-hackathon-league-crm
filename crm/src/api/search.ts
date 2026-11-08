// POST /crm/objects/2026-09/{objectType}/search: filterGroups (OR of ANDs), sorts, query,
// properties, limit (max 200), after (offset). Strings compare case-insensitively, enumerations
// exactly, numbers and dates numerically.
import { query } from "../store.js";
import { badRequest } from "./errors.js";
import { propertyDefs, toApi, type PropertyDef, type Row } from "./records.js";
import { queryProperties, resolveObjectType, type ObjectType } from "./schema.js";

type Filter = { propertyName?: string; operator?: string; value?: unknown; highValue?: unknown; values?: unknown[] };
export type SearchBody = {
  filterGroups?: Array<{ filters?: Filter[] }>; filters?: Filter[];
  sorts?: Array<string | { propertyName?: string; direction?: string }>;
  query?: string; properties?: string[]; limit?: number | string; after?: number | string;
};

const columnFor: Record<string, string> = {
  hs_object_id: "o.id", createdate: "o.created_at", hs_createdate: "o.created_at",
  lastmodifieddate: "o.updated_at", hs_lastmodifieddate: "o.updated_at",
};

function toMs(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  return Number.isFinite(ms) ? ms : null;
}

class Sql {
  readonly values: unknown[] = [];
  param(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

type Kind = "id" | "time" | "number" | "datetime" | "enum" | "string";

function kindOf(name: string, def: PropertyDef | undefined): Kind {
  if (name === "hs_object_id") return "id";
  if (columnFor[name]) return "time";
  if (def?.type === "number") return "number";
  if (def?.type === "datetime" || def?.type === "date") return "datetime";
  if (def?.type === "enumeration") return "enum";
  return "string";
}

function expression(name: string, kind: Kind): string {
  const raw = `(o.properties->>'${name}')`;
  switch (kind) {
    case "id": return "o.id";
    case "time": return `(extract(epoch FROM ${columnFor[name]}) * 1000)`;
    case "number": return `crm_num${raw}`;
    case "datetime": return `crm_ms${raw}`;
    case "enum": return raw;
    default: return `lower${raw}`;
  }
}

function literal(sql: Sql, value: unknown, kind: Kind): string {
  if (kind === "id") {
    const text = String(value ?? "").trim();
    if (!/^\d{1,18}$/.test(text)) throw badRequest(`${value} is not a valid record ID`);
    return `${sql.param(text)}::bigint`;
  }
  if (kind === "number") {
    const n = Number(String(value ?? "").trim());
    if (String(value ?? "").trim() === "" || !Number.isFinite(n)) throw badRequest(`${value} is not a valid number`);
    return `${sql.param(String(n))}::numeric`;
  }
  if (kind === "time" || kind === "datetime") {
    const ms = toMs(value);
    if (ms === null) throw badRequest(`${value} is not a valid date`);
    return `${sql.param(ms)}::double precision`;
  }
  if (kind === "enum") return sql.param(String(value ?? ""));
  return sql.param(String(value ?? "").toLowerCase());
}

const comparison: Record<string, string> = { EQ: "=", NEQ: "<>", LT: "<", LTE: "<=", GT: ">", GTE: ">=" };

function associationFilter(sql: Sql, type: ObjectType, filter: Filter): string {
  const target = resolveObjectType(String(filter.propertyName).slice("associations.".length));
  if (!target) throw badRequest(`Unknown association filter ${filter.propertyName}`);
  const values = filter.operator === "IN" ? (filter.values ?? []) : [filter.value];
  const ids = values.map((v) => String(v ?? "").trim()).filter((v) => /^\d+$/.test(v));
  const inner = `SELECT from_id::bigint FROM associations WHERE from_type = ${sql.param(type)} AND to_type = ${sql.param(target)} AND to_id = ANY(${sql.param(ids)}::text[])`;
  switch (filter.operator) {
    case "EQ": case "IN": return `o.id IN (${inner})`;
    case "NEQ": case "NOT_IN": return `o.id NOT IN (${inner})`;
    default: throw badRequest(`Operator ${filter.operator} is not supported for ${filter.propertyName}`);
  }
}

function filterSql(sql: Sql, type: ObjectType, defs: Map<string, PropertyDef>, filter: Filter): string {
  const name = String(filter.propertyName ?? "");
  if (name.startsWith("associations.")) return associationFilter(sql, type, filter);
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw badRequest(`Invalid property name ${name}`);
  const operator = String(filter.operator ?? "EQ").toUpperCase();
  const kind = kindOf(name, defs.get(name));
  const expr = expression(name, kind);
  const present = kind === "id" || kind === "time" ? "TRUE" : `coalesce(o.properties->>'${name}', '') <> ''`;
  if (operator in comparison) {
    const clause = `${expr} ${comparison[operator]} ${literal(sql, filter.value, kind)}`;
    return operator === "NEQ" ? `(NOT ${present} OR ${clause})` : clause;
  }
  switch (operator) {
    case "BETWEEN":
      return `${expr} BETWEEN ${literal(sql, filter.value, kind)} AND ${literal(sql, filter.highValue, kind)}`;
    case "IN": case "NOT_IN": {
      const list = (filter.values ?? []).map((v) => literal(sql, v, kind));
      if (!list.length) return operator === "IN" ? "FALSE" : "TRUE";
      const clause = `${expr} IN (${list.join(", ")})`;
      return operator === "IN" ? clause : `(NOT ${present} OR NOT ${clause})`;
    }
    case "HAS_PROPERTY": return present;
    case "NOT_HAS_PROPERTY": return `NOT ${present}`;
    case "CONTAINS_TOKEN": case "NOT_CONTAINS_TOKEN": {
      const token = String(filter.value ?? "").toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`);
      const pattern = token.includes("*") ? token.replace(/\*/g, "%") : `%${token}%`;
      const clause = `lower(coalesce(o.properties->>'${name}', '')) LIKE ${sql.param(pattern)}`;
      return operator === "CONTAINS_TOKEN" ? clause : `NOT ${clause}`;
    }
    default:
      throw badRequest(`Unsupported operator ${operator}`);
  }
}

function sortSql(type: ObjectType, defs: Map<string, PropertyDef>, sorts: SearchBody["sorts"]): string {
  const parts: string[] = [];
  for (const sort of sorts ?? []) {
    let name: string; let descending: boolean;
    if (typeof sort === "string") {
      descending = sort.startsWith("-");
      name = sort.replace(/^-/, "");
    } else {
      name = String(sort?.propertyName ?? "");
      descending = String(sort?.direction ?? "ASCENDING").toUpperCase().startsWith("DESC");
    }
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw badRequest(`Invalid sort property ${name}`);
    const kind = kindOf(name, defs.get(name));
    parts.push(`${expression(name, kind)} ${descending ? "DESC NULLS LAST" : "ASC NULLS LAST"}`);
  }
  parts.push("o.id ASC");
  return parts.join(", ");
}

// WHERE clause for a search body (shared by search and the UI/assistant helpers).
export async function whereFor(sql: Sql, type: ObjectType, body: SearchBody): Promise<string> {
  const defs = await propertyDefs(type);
  const clauses = [`o.type = ${sql.param(type)}`, "o.archived = FALSE"];
  const groups = body.filterGroups?.length ? body.filterGroups : body.filters?.length ? [{ filters: body.filters }] : [];
  const ors = groups
    .map((group) => (group.filters ?? []).map((f) => filterSql(sql, type, defs, f)))
    .filter((ands) => ands.length)
    .map((ands) => `(${ands.join(" AND ")})`);
  if (ors.length) clauses.push(`(${ors.join(" OR ")})`);
  const text = String(body.query ?? "").trim().toLowerCase();
  if (text) {
    const pattern = sql.param(`%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const fields = queryProperties[type].map((p) => `lower(coalesce(o.properties->>'${p}', '')) LIKE ${pattern}`);
    if (/^\d+$/.test(text)) fields.push(`o.id = ${sql.param(text)}::bigint`);
    clauses.push(`(${fields.join(" OR ")})`);
  }
  return clauses.join(" AND ");
}

export async function search(type: ObjectType, body: SearchBody): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(body.limit ?? 10) || 10, 1), 200);
  const after = Math.max(Number(body.after ?? 0) || 0, 0);
  const sql = new Sql();
  const where = await whereFor(sql, type, body);
  const defs = await propertyDefs(type);
  const order = sortSql(type, defs, body.sorts);
  const [rows, [count]] = await Promise.all([
    query<Row>(`SELECT o.id, o.type, o.properties, o.created_at, o.updated_at, o.archived FROM objects o
      WHERE ${where} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${after}`, sql.values),
    query<{ total: string }>(`SELECT count(*)::text AS total FROM objects o WHERE ${where}`, sql.values),
  ]);
  const page = rows.slice(0, limit);
  const requested = body.properties?.length ? body.properties.map(String) : undefined;
  const result: Record<string, unknown> = {
    total: Number(count?.total ?? 0),
    results: page.map((row) => toApi(row, type, requested, defs)),
  };
  if (rows.length > limit) result.paging = { next: { after: String(after + limit), link: "" } };
  return result;
}

export { Sql };
