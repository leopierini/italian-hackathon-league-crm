// Associations API (2026-09, v4 semantics) and association labels (schema), with /crm/v4 aliases.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db, query, withTransaction, type Db } from "../store.js";
import { ApiError, badRequest, notFound } from "./errors.js";
import { associate, associationTypes, defaultAssociation, getRow } from "./records.js";
import { objectTypeIds, type ObjectType } from "./schema.js";
import { typeParam } from "./objects.js";

type Pair = { objectType: string; objectId: string; toObjectType: string; toObjectId?: string };
type TypeInput = { associationCategory?: string; associationTypeId?: number | string };

const recordPrefixes = ["/crm/objects/2026-09", "/crm/v4/objects"];
const pairPrefixes = ["/crm/associations/2026-09", "/crm/v4/associations"];
const now = () => new Date().toISOString();

async function mustExist(client: Db, type: ObjectType, id: string): Promise<void> {
  if (!await getRow(client, type, id)) throw notFound(`${type} ${id} does not exist.`, { id: [String(id)] });
}

// Associations of one record towards one object type, grouped by target.
async function readAssociations(client: Db, fromType: ObjectType, fromIds: string[], toType: ObjectType) {
  const rows = await query<{ from_id: string; to_id: string; type_id: string; label: string | null; category: string | null }>(
    `SELECT a.from_id, a.to_id, a.type_id, NULLIF(t.label, '') AS label, t.category FROM associations a
     JOIN objects o ON o.id = a.to_id::bigint AND o.type = a.to_type AND o.archived = FALSE
     LEFT JOIN association_types t ON t.from_object_type = a.from_type AND t.to_object_type = a.to_type AND t.type_id = a.type_id
     WHERE a.from_type = $1 AND a.from_id = ANY($2::text[]) AND a.to_type = $3 ORDER BY a.to_id::bigint, a.type_id::bigint`,
    [fromType, fromIds.map(String), toType], client);
  const byFrom = new Map<string, Map<string, Array<Record<string, unknown>>>>();
  for (const row of rows) {
    const targets = byFrom.get(row.from_id) ?? new Map<string, Array<Record<string, unknown>>>();
    byFrom.set(row.from_id, targets);
    const types = targets.get(row.to_id) ?? [];
    targets.set(row.to_id, types);
    types.push({ category: row.category ?? "HUBSPOT_DEFINED", typeId: Number(row.type_id), label: row.label });
  }
  return (fromId: string) => [...(byFrom.get(String(fromId)) ?? new Map()).entries()]
    .map(([toObjectId, associationTypes]) => ({ toObjectId: Number(toObjectId), associationTypes }));
}

async function createLabeled(client: Db, fromType: ObjectType, fromId: string, toType: ObjectType, toId: string, types: TypeInput[]) {
  await mustExist(client, fromType, fromId);
  await mustExist(client, toType, toId);
  if (!types.length) await associate(client, fromType, fromId, toType, toId);
  for (const t of types) await associate(client, fromType, fromId, toType, toId, String(t.associationTypeId ?? ""));
  const all = await associationTypes(fromType, toType, client);
  const rows = await query<{ type_id: string }>(
    `SELECT type_id FROM associations WHERE from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4`,
    [fromType, String(fromId), toType, String(toId)], client);
  const labels = rows.map((r) => all.find((t) => t.type_id === r.type_id)?.label).filter((l): l is string => !!l);
  return {
    fromObjectTypeId: objectTypeIds[fromType], fromObjectId: Number(fromId),
    toObjectTypeId: objectTypeIds[toType], toObjectId: Number(toId), labels,
  };
}

async function removeAll(client: Db, fromType: ObjectType, fromId: string, toType: ObjectType, toId: string) {
  await client.query(
    `DELETE FROM associations WHERE (from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4)
       OR (from_type = $3 AND from_id = $4 AND to_type = $1 AND to_id = $2)`,
    [fromType, String(fromId), toType, String(toId)]);
}

async function removeTypes(client: Db, fromType: ObjectType, fromId: string, toType: ObjectType, toId: string, types: TypeInput[]) {
  const all = await associationTypes(fromType, toType, client);
  const plain = await defaultAssociation(fromType, toType, client);
  for (const t of types) {
    const typeId = String(t.associationTypeId ?? "");
    // Removing the default (unlabeled) type removes the whole association.
    if (typeId === plain.typeId) {
      await removeAll(client, fromType, fromId, toType, toId);
      continue;
    }
    const info = all.find((a) => a.type_id === typeId);
    await client.query(
      `DELETE FROM associations WHERE (from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4 AND type_id = $5)
         OR (from_type = $3 AND from_id = $4 AND to_type = $1 AND to_id = $2 AND type_id = $6)`,
      [fromType, String(fromId), toType, String(toId), typeId, info?.inverse_type_id ?? typeId]);
  }
}

export function registerAssociationRoutes(app: FastifyInstance): void {
  for (const prefix of recordPrefixes) {
    app.put(`${prefix}/:objectType/:objectId/associations/default/:toObjectType/:toObjectId`, async (request: FastifyRequest<{ Params: Pair }>) => {
      const startedAt = now();
      const from = typeParam(request.params.objectType);
      const to = typeParam(request.params.toObjectType);
      const { objectId, toObjectId } = request.params;
      const plain = await withTransaction(async (client) => {
        await mustExist(client, from, objectId);
        await mustExist(client, to, toObjectId!);
        await associate(client, from, objectId, to, toObjectId!);
        return defaultAssociation(from, to, client);
      });
      return {
        status: "COMPLETE",
        results: [
          { from: { id: String(objectId) }, to: { id: String(toObjectId) }, associationSpec: { associationCategory: "HUBSPOT_DEFINED", associationTypeId: Number(plain.typeId) } },
          { from: { id: String(toObjectId) }, to: { id: String(objectId) }, associationSpec: { associationCategory: "HUBSPOT_DEFINED", associationTypeId: Number(plain.inverse) } },
        ],
        startedAt, completedAt: now(),
      };
    });

    app.put(`${prefix}/:objectType/:objectId/associations/:toObjectType/:toObjectId`, async (request: FastifyRequest<{ Params: Pair; Body: TypeInput[] }>, reply) => {
      const from = typeParam(request.params.objectType);
      const to = typeParam(request.params.toObjectType);
      const types = Array.isArray(request.body) ? request.body : [];
      const result = await withTransaction((client) => createLabeled(client, from, request.params.objectId, to, request.params.toObjectId!, types));
      return reply.code(201).send(result);
    });

    app.delete(`${prefix}/:objectType/:objectId/associations/:toObjectType/:toObjectId`, async (request: FastifyRequest<{ Params: Pair }>, reply) => {
      const from = typeParam(request.params.objectType);
      const to = typeParam(request.params.toObjectType);
      await removeAll(db(), from, request.params.objectId, to, request.params.toObjectId!);
      return reply.code(204).send();
    });

    app.get(`${prefix}/:objectType/:objectId/associations/:toObjectType`, async (request: FastifyRequest<{ Params: Pair; Querystring: { limit?: string; after?: string } }>) => {
      const from = typeParam(request.params.objectType);
      const to = typeParam(request.params.toObjectType);
      await mustExist(db(), from, request.params.objectId);
      const all = (await readAssociations(db(), from, [request.params.objectId], to))(request.params.objectId);
      const limit = Math.min(Math.max(Number(request.query.limit ?? 500) || 500, 1), 500);
      const offset = Math.max(Number(request.query.after ?? 0) || 0, 0);
      const body: Record<string, unknown> = { results: all.slice(offset, offset + limit) };
      if (offset + limit < all.length) body.paging = { next: { after: String(offset + limit), link: "" } };
      return body;
    });
  }

  for (const prefix of pairPrefixes) {
    type BatchBody = { inputs?: Array<{ from?: { id?: string }; to?: { id?: string } | Array<{ id?: string }>; types?: TypeInput[]; id?: string }> };
    const pairOf = (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string } }>) =>
      [typeParam(request.params.fromObjectType), typeParam(request.params.toObjectType)] as const;
    const inputsOf = (body: BatchBody | undefined) => {
      if (!Array.isArray(body?.inputs)) throw badRequest("Request body must contain an inputs array.");
      return body!.inputs!;
    };

    app.post(`${prefix}/:fromObjectType/:toObjectType/batch/associate/default`, async (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string }; Body: BatchBody }>) => {
      const startedAt = now();
      const [from, to] = pairOf(request);
      const inputs = inputsOf(request.body);
      const results = await withTransaction(async (client) => {
        const plain = await defaultAssociation(from, to, client);
        const out: unknown[] = [];
        for (const input of inputs) {
          const fromId = String(input.from?.id ?? "");
          const toId = String((input.to as { id?: string })?.id ?? "");
          await mustExist(client, from, fromId);
          await mustExist(client, to, toId);
          await associate(client, from, fromId, to, toId);
          out.push({ from: { id: fromId }, to: { id: toId }, associationSpec: { associationCategory: "HUBSPOT_DEFINED", associationTypeId: Number(plain.typeId) } });
          out.push({ from: { id: toId }, to: { id: fromId }, associationSpec: { associationCategory: "HUBSPOT_DEFINED", associationTypeId: Number(plain.inverse) } });
        }
        return out;
      });
      return { status: "COMPLETE", results, startedAt, completedAt: now() };
    });

    app.post(`${prefix}/:fromObjectType/:toObjectType/batch/create`, async (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string }; Body: BatchBody }>, reply) => {
      const startedAt = now();
      const [from, to] = pairOf(request);
      const inputs = inputsOf(request.body);
      const results = await withTransaction(async (client) => {
        const out: unknown[] = [];
        for (const input of inputs) {
          out.push(await createLabeled(client, from, String(input.from?.id ?? ""), to, String((input.to as { id?: string })?.id ?? ""), input.types ?? []));
        }
        return out;
      });
      return reply.code(201).send({ status: "COMPLETE", results, startedAt, completedAt: now() });
    });

    app.post(`${prefix}/:fromObjectType/:toObjectType/batch/read`, async (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string }; Body: BatchBody }>, reply) => {
      const startedAt = now();
      const [from, to] = pairOf(request);
      const ids = inputsOf(request.body).map((i) => String(i.id ?? ""));
      const existing = new Set((await query<{ id: string }>(
        `SELECT id FROM objects WHERE type = $1 AND archived = FALSE AND id = ANY($2::bigint[])`,
        [from, ids.filter((id) => /^\d{1,18}$/.test(id))])).map((r) => String(r.id)));
      const read = await readAssociations(db(), from, ids, to);
      const results = ids.filter((id) => existing.has(id)).map((id) => ({ from: { id }, to: read(id) })).filter((r) => r.to.length);
      const missing = ids.filter((id) => !existing.has(id));
      const body: Record<string, unknown> = { status: "COMPLETE", results, startedAt, completedAt: now() };
      if (missing.length) {
        body.numErrors = missing.length;
        body.errors = missing.map((id) => ({ status: "error", category: "OBJECT_NOT_FOUND", message: `No ${from} is associated with id ${id}`, context: { fromObjectId: [id] }, errors: [] }));
        return reply.code(207).send(body);
      }
      return body;
    });

    app.post(`${prefix}/:fromObjectType/:toObjectType/batch/archive`, async (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string }; Body: BatchBody }>, reply) => {
      const [from, to] = pairOf(request);
      await withTransaction(async (client) => {
        for (const input of inputsOf(request.body)) {
          const targets = Array.isArray(input.to) ? input.to : [input.to ?? {}];
          for (const target of targets) await removeAll(client, from, String(input.from?.id ?? ""), to, String(target?.id ?? ""));
        }
      });
      return reply.code(204).send();
    });

    app.post(`${prefix}/:fromObjectType/:toObjectType/batch/labels/archive`, async (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string }; Body: BatchBody }>, reply) => {
      const [from, to] = pairOf(request);
      await withTransaction(async (client) => {
        for (const input of inputsOf(request.body)) {
          await removeTypes(client, from, String(input.from?.id ?? ""), to, String((input.to as { id?: string })?.id ?? ""), input.types ?? []);
        }
      });
      return reply.code(204).send();
    });

    // ---- labels (associations schema) ----

    app.get(`${prefix}/:fromObjectType/:toObjectType/labels`, async (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string } }>) => {
      const [from, to] = pairOf(request);
      const types = await associationTypes(from, to);
      return { results: types.map((t) => ({ category: t.category, typeId: Number(t.type_id), label: t.label })) };
    });

    app.post(`${prefix}/:fromObjectType/:toObjectType/labels`, async (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string }; Body: { label?: string; name?: string; inverseLabel?: string } }>) => {
      const [from, to] = pairOf(request);
      const label = String(request.body?.label ?? "").trim();
      if (!label) throw badRequest("label is required");
      const inverse = String(request.body?.inverseLabel ?? "").trim() || label;
      return withTransaction(async (client) => {
        await client.query("LOCK TABLE association_types IN EXCLUSIVE MODE");
        const [{ next }] = await query<{ next: number }>(
          `SELECT coalesce(max(type_id::bigint), 0)::int + 1 AS next FROM association_types WHERE type_id ~ '^[0-9]+$'`, [], client) as [{ next: number }];
        const forward = String(next);
        const backward = String(next + 1);
        await client.query(
          `INSERT INTO association_types (from_object_type, to_object_type, type_id, inverse_type_id, label, category)
           VALUES ($1, $2, $3, $4, $5, 'USER_DEFINED'), ($2, $1, $4, $3, $6, 'USER_DEFINED')`,
          [from, to, forward, backward, label, inverse]);
        const results = [{ category: "USER_DEFINED", typeId: next, label }];
        if (from === to || inverse !== label) results.push({ category: "USER_DEFINED", typeId: next + 1, label: inverse });
        return { results };
      });
    });

    app.put(`${prefix}/:fromObjectType/:toObjectType/labels`, async (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string }; Body: { associationTypeId?: number | string; label?: string; inverseLabel?: string } }>, reply) => {
      const [from, to] = pairOf(request);
      const typeId = String(request.body?.associationTypeId ?? "");
      const types = await associationTypes(from, to);
      const found = types.find((t) => t.type_id === typeId && t.category === "USER_DEFINED");
      if (!found) throw new ApiError(404, "OBJECT_NOT_FOUND", `Association label ${typeId} not found.`);
      if (request.body?.label) await query(`UPDATE association_types SET label = $1 WHERE from_object_type = $2 AND to_object_type = $3 AND type_id = $4`, [request.body.label, from, to, typeId]);
      if (request.body?.inverseLabel && found.inverse_type_id) {
        await query(`UPDATE association_types SET label = $1 WHERE from_object_type = $2 AND to_object_type = $3 AND type_id = $4`, [request.body.inverseLabel, to, from, found.inverse_type_id]);
      }
      return reply.code(204).send();
    });

    app.delete(`${prefix}/:fromObjectType/:toObjectType/labels/:associationTypeId`, async (request: FastifyRequest<{ Params: { fromObjectType: string; toObjectType: string; associationTypeId: string } }>, reply) => {
      const [from, to] = pairOf(request);
      const typeId = request.params.associationTypeId;
      const types = await associationTypes(from, to);
      const found = types.find((t) => t.type_id === typeId && t.category === "USER_DEFINED");
      if (!found) throw new ApiError(404, "OBJECT_NOT_FOUND", `Association label ${typeId} not found.`);
      await withTransaction(async (client) => {
        for (const [a, b, id] of [[from, to, typeId], [to, from, found.inverse_type_id ?? typeId]] as const) {
          await client.query(`DELETE FROM association_types WHERE from_object_type = $1 AND to_object_type = $2 AND type_id = $3 AND category = 'USER_DEFINED'`, [a, b, id]);
          await client.query(`DELETE FROM associations WHERE from_type = $1 AND to_type = $2 AND type_id = $3`, [a, b, id]);
        }
      });
      return reply.code(204).send();
    });
  }
}
