// Objects API (2026-09): /crm/objects/2026-09/{objectType}[/{objectId}|/batch/*|/search], with
// /crm/v3/objects aliases.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db, query, withTransaction } from "../store.js";
import { ApiError, badRequest, notFound } from "./errors.js";
import {
  archiveRecord, createRecord, getRow, getRows, propertyDefs, toApi, updateRecord, upsertRecord,
  type AssociationInput, type Row,
} from "./records.js";
import { search, type SearchBody } from "./search.js";
import { resolveObjectType, singular, type ObjectType } from "./schema.js";

type Params = { objectType: string; objectId?: string };
type Query = { properties?: string | string[]; associations?: string | string[]; limit?: string; after?: string; archived?: string; idProperty?: string };

export const objectPrefixes = ["/crm/objects/2026-09", "/crm/v3/objects"];

export function typeParam(raw: string | undefined): ObjectType {
  const type = resolveObjectType(raw);
  if (!type) throw badRequest(`Unable to infer object type from: ${raw}`);
  return type;
}

// `properties=a,b` or repeated `properties=a&properties=b`.
export function listParam(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

// `associations=companies,deals` on reads: {companies: {results: [{id, type}]}}.
async function withAssociations(type: ObjectType, rows: Row[], outputs: Array<Record<string, unknown>>, wanted: string[] | undefined) {
  if (!wanted?.length || !rows.length) return;
  const ids = rows.map((r) => String(r.id));
  for (const raw of wanted) {
    const toType = resolveObjectType(raw);
    if (!toType) continue;
    const links = await query<{ from_id: string; to_id: string; type_id: string; label: string | null }>(
      `SELECT a.from_id, a.to_id, a.type_id, NULLIF(t.label, '') AS label FROM associations a
       LEFT JOIN association_types t ON t.from_object_type = a.from_type AND t.to_object_type = a.to_type AND t.type_id = a.type_id
       WHERE a.from_type = $1 AND a.from_id = ANY($2::text[]) AND a.to_type = $3 ORDER BY a.id`,
      [type, ids, toType]);
    rows.forEach((row, index) => {
      const results = links.filter((l) => l.from_id === String(row.id)).map((l) => ({
        id: l.to_id,
        type: l.label ? l.label.toLowerCase().replace(/\s+/g, "_") : `${singular(type)}_to_${singular(toType)}`,
      }));
      if (!results.length) return;
      const out = outputs[index]!;
      const associations = (out.associations ?? {}) as Record<string, unknown>;
      associations[raw] = { results };
      out.associations = associations;
    });
  }
}

const now = () => new Date().toISOString();

function batchResponse(reply: FastifyReply, okStatus: number, results: unknown[], errors: unknown[], startedAt: string) {
  const body: Record<string, unknown> = { status: "COMPLETE", results, startedAt, completedAt: now() };
  if (errors.length) {
    body.numErrors = errors.length;
    body.errors = errors;
    return reply.code(207).send(body);
  }
  return reply.code(okStatus).send(body);
}

const missing = (type: ObjectType, ids: string[]) => ({
  status: "error", category: "OBJECT_NOT_FOUND",
  message: `Could not get some ${type.toUpperCase()} objects, they may be deleted or not exist. Check that ids are valid.`,
  context: { ids }, errors: [],
});

type Inputs<T> = { inputs?: T[]; properties?: string[]; idProperty?: string; propertiesWithHistory?: string[] };

// Create/update bodies: a JSON object whose `properties` (when present) is an object.
function objectBody<T extends { properties?: Record<string, unknown> }>(body: T | undefined): T {
  if (body === undefined || body === null) return {} as T;
  if (typeof body !== "object" || Array.isArray(body)) throw badRequest("The request body must be a JSON object.");
  if (body.properties !== undefined && body.properties !== null && (typeof body.properties !== "object" || Array.isArray(body.properties))) {
    throw badRequest("properties must be an object");
  }
  return body;
}

function inputsOf<T>(body: Inputs<T> | undefined, max = 100): T[] {
  const inputs = body?.inputs;
  if (!Array.isArray(inputs)) throw badRequest("Request body must contain an inputs array.");
  if (inputs.length > max) throw badRequest(`Batch size cannot exceed ${max} inputs.`);
  return inputs;
}

export function registerObjectRoutes(app: FastifyInstance): void {
  for (const prefix of objectPrefixes) {
    // List with keyset paging on id.
    app.get(`${prefix}/:objectType`, async (request: FastifyRequest<{ Params: Params; Querystring: Query }>) => {
      const type = typeParam(request.params.objectType);
      const limit = Math.min(Math.max(Number(request.query.limit ?? 10) || 10, 1), 100);
      const after = /^\d+$/.test(request.query.after ?? "") ? request.query.after! : "0";
      const archived = request.query.archived === "true";
      const rows = await query<Row>(
        `SELECT id, type, properties, created_at, updated_at, archived FROM objects
         WHERE type = $1 AND archived = $2 AND id > $3 ORDER BY id LIMIT $4`,
        [type, archived, after, limit + 1]);
      const page = rows.slice(0, limit);
      const defs = await propertyDefs(type);
      const requested = listParam(request.query.properties);
      const results = page.map((row) => toApi(row, type, requested, defs));
      await withAssociations(type, page, results, listParam(request.query.associations));
      const body: Record<string, unknown> = { results };
      if (rows.length > limit) {
        const next = String(page.at(-1)!.id);
        body.paging = { next: { after: next, link: `${prefix}/${request.params.objectType}?after=${next}` } };
      }
      return body;
    });

    app.get(`${prefix}/:objectType/:objectId`, async (request: FastifyRequest<{ Params: Params; Querystring: Query }>) => {
      const type = typeParam(request.params.objectType);
      const row = await getRow(db(), type, request.params.objectId!, {
        idProperty: request.query.idProperty, archived: request.query.archived === "true",
      });
      if (!row) throw notFound("Object not found.  objectId are usually numeric.", { id: [request.params.objectId!] });
      const out = toApi(row, type, listParam(request.query.properties), await propertyDefs(type));
      await withAssociations(type, [row], [out], listParam(request.query.associations));
      return out;
    });

    app.post(`${prefix}/:objectType`, async (request: FastifyRequest<{ Params: Params; Body: { properties?: Record<string, unknown>; associations?: AssociationInput[] } }>, reply) => {
      const type = typeParam(request.params.objectType);
      const body = objectBody(request.body);
      const row = await withTransaction((client) => createRecord(client, type, body.properties ?? {}, body.associations));
      return reply.code(201).send(toApi(row, type));
    });

    app.patch(`${prefix}/:objectType/:objectId`, async (request: FastifyRequest<{ Params: Params; Querystring: Query; Body: { properties?: Record<string, unknown> } }>) => {
      const type = typeParam(request.params.objectType);
      const body = objectBody(request.body);
      const row = await withTransaction((client) => updateRecord(client, type, request.params.objectId!, body.properties ?? {}, {
        idProperty: request.query.idProperty,
      }));
      return toApi(row, type);
    });

    app.delete(`${prefix}/:objectType/:objectId`, async (request: FastifyRequest<{ Params: Params; Querystring: Query }>, reply) => {
      const type = typeParam(request.params.objectType);
      await withTransaction((client) => archiveRecord(client, type, request.params.objectId!, request.query.idProperty));
      return reply.code(204).send();
    });

    app.post(`${prefix}/:objectType/search`, async (request: FastifyRequest<{ Params: Params; Body: SearchBody }>) => {
      const type = typeParam(request.params.objectType);
      return search(type, request.body ?? {});
    });

    // ---- batch ----

    app.post(`${prefix}/:objectType/batch/read`, async (request: FastifyRequest<{ Params: Params; Querystring: Query; Body: Inputs<{ id: string }> }>, reply) => {
      const startedAt = now();
      const type = typeParam(request.params.objectType);
      const inputs = inputsOf(request.body, 100);
      const ids = inputs.map((i) => String(i?.id ?? ""));
      const idProperty = request.body?.idProperty;
      const archived = request.query.archived === "true";
      let rows: Row[];
      if (idProperty && idProperty !== "hs_object_id") {
        rows = (await Promise.all(ids.map((id) => getRow(db(), type, id, { idProperty })))).filter((r): r is Row => !!r);
      } else {
        rows = await getRows(type, ids, archived);
      }
      const defs = await propertyDefs(type);
      const requested = request.body?.properties?.length ? request.body.properties : undefined;
      const found = new Set(rows.flatMap((r) => [String(r.id), idProperty ? String(r.properties[idProperty] ?? "").toLowerCase() : ""]));
      const absent = ids.filter((id) => !found.has(id) && !found.has(id.toLowerCase()));
      return batchResponse(reply, 200, rows.map((row) => toApi(row, type, requested, defs)), absent.length ? [missing(type, absent)] : [], startedAt);
    });

    app.post(`${prefix}/:objectType/batch/create`, async (request: FastifyRequest<{ Params: Params; Body: Inputs<{ properties?: Record<string, unknown>; associations?: AssociationInput[] }> }>, reply) => {
      const startedAt = now();
      const type = typeParam(request.params.objectType);
      const inputs = inputsOf(request.body);
      // With objectWriteTraceId on the inputs, failures are per input (207 multi-status);
      // otherwise the batch is atomic and the first error fails it.
      const multiStatus = inputs.some((input) => (input as { objectWriteTraceId?: string })?.objectWriteTraceId !== undefined);
      const errors: unknown[] = [];
      const rows = await withTransaction(async (client) => {
        const created: Row[] = [];
        for (const input of inputs) {
          const body = objectBody(input);
          if (!multiStatus) {
            created.push(await createRecord(client, type, body.properties ?? {}, body.associations));
            continue;
          }
          await client.query("SAVEPOINT batch_input");
          try {
            created.push(await createRecord(client, type, body.properties ?? {}, body.associations));
            await client.query("RELEASE SAVEPOINT batch_input");
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            await client.query("ROLLBACK TO SAVEPOINT batch_input");
            const { correlationId: _, ...detail } = error.body();
            errors.push({ ...detail, context: { objectWriteTraceId: [String((input as { objectWriteTraceId?: string }).objectWriteTraceId ?? "")] } });
          }
        }
        return created;
      });
      return batchResponse(reply, 201, rows.map((row) => toApi(row, type)), errors, startedAt);
    });

    app.post(`${prefix}/:objectType/batch/update`, async (request: FastifyRequest<{ Params: Params; Body: Inputs<{ id: string; idProperty?: string; properties?: Record<string, unknown> }> }>, reply) => {
      const startedAt = now();
      const type = typeParam(request.params.objectType);
      const inputs = inputsOf(request.body);
      const absent: string[] = [];
      const rows = await withTransaction(async (client) => {
        const updated: Row[] = [];
        for (const input of inputs) {
          try {
            updated.push(await updateRecord(client, type, String(input?.id ?? ""), input?.properties ?? {}, {
              idProperty: input?.idProperty ?? request.body?.idProperty,
            }));
          } catch (error) {
            if (error instanceof ApiError && error.statusCode === 404) absent.push(String(input?.id ?? ""));
            else throw error;
          }
        }
        return updated;
      });
      return batchResponse(reply, 200, rows.map((row) => toApi(row, type)), absent.length ? [missing(type, absent)] : [], startedAt);
    });

    app.post(`${prefix}/:objectType/batch/upsert`, async (request: FastifyRequest<{ Params: Params; Body: Inputs<{ id: string; idProperty?: string; properties?: Record<string, unknown> }> }>, reply) => {
      const startedAt = now();
      const type = typeParam(request.params.objectType);
      const inputs = inputsOf(request.body);
      const results = await withTransaction(async (client) => {
        const out: Array<Record<string, unknown>> = [];
        for (const input of inputs) {
          const idProperty = input?.idProperty ?? request.body?.idProperty ?? (type === "contacts" ? "email" : "hs_object_id");
          const id = String(input?.id ?? "");
          if (!id) throw badRequest("Each input needs an id.");
          const { row, created } = await upsertRecord(client, type, idProperty, id, input?.properties ?? {});
          out.push({ ...toApi(row, type), new: created });
        }
        return out;
      });
      return batchResponse(reply, 200, results, [], startedAt);
    });

    app.post(`${prefix}/:objectType/batch/archive`, async (request: FastifyRequest<{ Params: Params; Body: Inputs<{ id: string }> }>, reply) => {
      const type = typeParam(request.params.objectType);
      const inputs = inputsOf(request.body);
      await withTransaction(async (client) => {
        for (const input of inputs) await archiveRecord(client, type, String(input?.id ?? ""), request.body?.idProperty);
      });
      return reply.code(204).send();
    });
  }
}
