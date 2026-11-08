// Exports API, 2026-09: POST /crm/exports/2026-09/export/async starts an export (202), the status
// endpoint returns `result` = a relative link that downloads the CSV without a token, like
// HubSpot's signed links (the auth hook lets GET /exports/{id}/download through).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { query } from "../store.js";
import { badRequest, notFound } from "./errors.js";
import { listMembersSql } from "./lists.js";
import { propertyDefs } from "./records.js";
import { objectTypeIds, resolveObjectType, singular, type ObjectType } from "./schema.js";
import { Sql, whereFor, type SearchBody } from "./search.js";

const prefixes = ["/crm/exports/2026-09", "/crm/v3/exports"];

type ExportRequest = {
  exportType?: string; exportName?: string; format?: string; language?: string; objectType?: string;
  objectProperties?: string[]; associatedObjectType?: string | string[]; exportInternalValuesOptions?: string[];
  listId?: string | number; publicCrmSearchRequest?: {
    filterGroups?: Array<{ filters?: Array<Record<string, unknown>> }>; sorts?: Array<Record<string, unknown>>; query?: string;
  };
};
type ExportRow = {
  id: string; request: ExportRequest & { objectTypeId: string }; state: string; token: string; record_count: number | null;
  error: string | null; created_at: Date; updated_at: Date;
};

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const linkFor = (row: ExportRow) => `/exports/${row.id}/download?token=${row.token}`;

async function buildCsv(request: ExportRequest & { objectTypeId: string }): Promise<{ csv: string; count: number }> {
  const type = resolveObjectType(request.objectTypeId)!;
  const defs = await propertyDefs(type);
  const internalNames = (request.exportInternalValuesOptions ?? []).map((o) => String(o).toUpperCase()).includes("NAMES");
  const properties = [...new Set(["hs_object_id", ...(request.objectProperties ?? []).map(String)])]
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name));
  const associated = (Array.isArray(request.associatedObjectType) ? request.associatedObjectType : request.associatedObjectType ? [request.associatedObjectType] : [])
    .map((t) => resolveObjectType(String(t))).filter((t): t is ObjectType => !!t);

  const sql = new Sql();
  let from: string;
  let order = "o.id";
  if (String(request.exportType).toUpperCase() === "LIST") {
    const members = await listMembersSql(sql, String(request.listId ?? ""));
    from = `objects o WHERE o.archived = FALSE AND o.id IN (${members.text})`;
  } else {
    const search = request.publicCrmSearchRequest ?? {};
    const body: SearchBody = {
      query: search.query,
      filterGroups: (search.filterGroups ?? []).map((group) => ({
        filters: (group.filters ?? []).map((f) => ({ ...f, propertyName: String(f.propertyName ?? f.property ?? "") })),
      })),
    };
    from = `objects o WHERE ${await whereFor(sql, type, body)}`;
    const sort = search.sorts?.[0];
    const sortName = String(sort?.propertyName ?? sort?.property ?? "");
    if (/^[A-Za-z0-9_]+$/.test(sortName) && sortName !== "hs_object_id") {
      const direction = String(sort?.direction ?? sort?.order ?? "ASC").toUpperCase().startsWith("DESC") ? "DESC" : "ASC";
      order = `lower(o.properties->>'${sortName}') ${direction} NULLS LAST, o.id`;
    }
  }
  const rows = await query<{ id: string; properties: Record<string, unknown>; created_at: Date; updated_at: Date }>(
    `SELECT o.id::text AS id, o.properties, o.created_at, o.updated_at FROM ${from} ORDER BY ${order}`, sql.values);

  const links = new Map<string, Map<string, string[]>>();
  for (const toType of associated) {
    const byRecord = new Map<string, string[]>();
    const assoc = await query<{ from_id: string; to_id: string }>(
      `SELECT DISTINCT from_id, to_id FROM associations WHERE from_type = $1 AND to_type = $2 AND from_id = ANY($3::text[]) ORDER BY from_id, to_id`,
      [type, toType, rows.map((r) => r.id)]);
    for (const a of assoc) byRecord.set(a.from_id, [...(byRecord.get(a.from_id) ?? []), a.to_id]);
    links.set(toType, byRecord);
  }

  const header = properties.map((name) => (internalNames ? name : name === "hs_object_id" ? "Record ID" : defs.get(name)?.label ?? name));
  for (const toType of associated) header.push(internalNames ? `associated_${singular(toType)}_ids` : `Associated ${singular(toType).replace(/_/g, " ")} IDs`);
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    const cells = properties.map((name) => {
      if (name === "hs_object_id") return row.id;
      if (name === "createdate" || name === "hs_createdate") return row.properties[name] ?? new Date(row.created_at).toISOString();
      if (name === "lastmodifieddate" || name === "hs_lastmodifieddate") return new Date(row.updated_at).toISOString();
      return row.properties[name];
    });
    for (const toType of associated) cells.push((links.get(toType)?.get(row.id) ?? []).join(";"));
    lines.push(cells.map(csvCell).join(","));
  }
  return { csv: `${lines.join("\r\n")}\r\n`, count: rows.length };
}

// Runs after the 202 is sent; the status endpoint reports PROCESSING until the row is DONE.
async function runExport(row: ExportRow): Promise<void> {
  try {
    const { csv, count } = await buildCsv(row.request);
    await query(`UPDATE exports SET state = 'DONE', file = $2, record_count = $3, updated_at = NOW() WHERE id = $1`, [row.id, csv, count]);
  } catch (error) {
    await query(`UPDATE exports SET state = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`, [row.id, (error as Error).message])
      .catch(() => undefined);
  }
}

async function getExport(id: string): Promise<ExportRow> {
  if (!/^\d{1,18}$/.test(id)) throw notFound(`Export ${id} does not exist.`);
  const [row] = await query<ExportRow>(
    `SELECT id::text, request, state, token, record_count, error, created_at, updated_at FROM exports WHERE id = $1`, [id]);
  if (!row) throw notFound(`Export ${id} does not exist.`);
  return row;
}

type Req = FastifyRequest<{ Params: { taskId: string; exportId: string; id: string }; Querystring: { token?: string }; Body: ExportRequest | undefined }>;

export function registerExportRoutes(app: FastifyInstance): void {
  for (const prefix of prefixes) {
    app.post(`${prefix}/export/async`, async (request: Req, reply) => {
      const body = request.body ?? {};
      const exportType = String(body.exportType ?? "").toUpperCase();
      if (!["VIEW", "LIST"].includes(exportType)) throw badRequest("exportType must be VIEW or LIST.");
      const type = resolveObjectType(String(body.objectType ?? ""));
      if (!type) throw badRequest(`Unknown objectType: ${body.objectType}`);
      const format = String(body.format ?? "CSV").toUpperCase();
      if (!["CSV", "XLS", "XLSX"].includes(format)) throw badRequest("format must be CSV, XLS or XLSX.");
      if (body.objectProperties !== undefined && !Array.isArray(body.objectProperties)) throw badRequest("objectProperties must be an array.");
      if (exportType === "LIST" && (body.listId === undefined || body.listId === null || body.listId === "")) throw badRequest("listId is required for a LIST export.");
      // A LIST export of a missing list fails now with 404, not later in the background.
      if (exportType === "LIST") await listMembersSql(new Sql(), String(body.listId));
      const stored = { ...body, exportType, format, objectTypeId: objectTypeIds[type] };
      const [row] = await query<ExportRow>(
        `INSERT INTO exports (request, token) VALUES ($1::jsonb, $2)
         RETURNING id::text, request, state, token, record_count, error, created_at, updated_at`,
        [JSON.stringify(stored), randomBytes(24).toString("hex")]);
      void runExport(row!);
      return reply.code(202).send({ id: row!.id, links: { status: `${prefix}/export/async/tasks/${row!.id}/status` } });
    });

    app.get(`${prefix}/export/async/tasks/:taskId/status`, async (request: Req) => {
      const row = await getExport(request.params.taskId);
      const status = row.state === "DONE" ? "COMPLETE" : row.state === "FAILED" ? "CANCELED" : "PROCESSING";
      const out: Record<string, unknown> = {
        status,
        requestedAt: row.created_at.toISOString(),
        startedAt: row.created_at.toISOString(),
        completedAt: (row.state === "PROCESSING" ? new Date() : row.updated_at).toISOString(),
        links: {},
      };
      if (status === "COMPLETE") out.result = linkFor(row);
      if (row.error) {
        out.numErrors = 1;
        out.errors = [{ status: "error", category: "INTERNAL_ERROR", message: row.error, context: {}, errors: [], links: {} }];
      }
      return out;
    });

    app.get(`${prefix}/export/:exportId`, async (request: Req) => {
      const row = await getExport(request.params.exportId);
      return {
        id: row.id,
        exportName: row.request.exportName ?? `export-${row.id}`,
        exportType: row.request.exportType,
        objectType: row.request.objectTypeId,
        objectProperties: row.request.objectProperties ?? [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        exportState: row.state === "DONE" ? "DONE" : row.state === "FAILED" ? "FAILED" : "PROCESSING",
        ...(row.record_count === null ? {} : { recordCount: row.record_count }),
      };
    });
  }

  // Signed download link: no bearer token, the random token in the URL is the credential.
  app.get("/exports/:id/download", async (request: Req, reply) => {
    const id = request.params.id;
    if (!/^\d{1,18}$/.test(id)) throw notFound("Export file not found.");
    const [row] = await query<{ token: string; file: string | null; request: ExportRequest }>(
      `SELECT token, file, request FROM exports WHERE id = $1 AND state = 'DONE'`, [id]);
    const given = Buffer.from(String(request.query.token ?? ""));
    const expected = Buffer.from(row?.token ?? "");
    if (!row || row.file === null || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw notFound("Export file not found.");
    }
    const name = String(row.request.exportName ?? `export-${id}`).replace(/[^A-Za-z0-9 ._-]/g, "_");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}.csv"`)
      .send(row.file);
  });
}
