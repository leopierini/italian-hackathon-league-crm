// Properties API (2026-09) and property groups, with /crm/v3/properties aliases.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { query, withTransaction } from "../store.js";
import { ApiError, badRequest, conflict, notFound } from "./errors.js";
import { invalidateSchemaCache } from "./records.js";
import { defaultGroups } from "./schema.js";
import { typeParam } from "./objects.js";

const prefixes = ["/crm/properties/2026-09", "/crm/v3/properties"];

type PropertyRow = {
  object_type: string; name: string; label: string; type: string; field_type: string; group_name: string | null;
  description: string; options: unknown[]; display_order: number; has_unique_value: boolean; hubspot_defined: boolean;
  form_field: boolean; hidden: boolean; archived: boolean; created_at: Date; updated_at: Date;
};
type PropertyBody = {
  name?: string; label?: string; type?: string; fieldType?: string; groupName?: string; description?: string;
  options?: Array<{ label?: string; value?: string; displayOrder?: number; hidden?: boolean; description?: string }>;
  displayOrder?: number; hasUniqueValue?: boolean; hidden?: boolean; formField?: boolean;
};

const columns = `object_type, name, label, type, field_type, group_name, description, options, display_order,
  has_unique_value, hubspot_defined, form_field, hidden, archived, created_at, updated_at`;
const types = new Set(["string", "number", "date", "datetime", "enumeration", "bool", "phone_number", "object_coordinates", "json"]);
const fieldTypes = new Set(["text", "textarea", "number", "date", "file", "select", "radio", "checkbox", "booleancheckbox", "calculation_equation", "phonenumber", "html", "calculation_rollup", "calculation_score", "unknown"]);

const groupFor = (objectType: string) => defaultGroups.find((g) => g.objectType === objectType)?.name ?? "";

function toApi(row: PropertyRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: row.name, label: row.label, type: row.type, fieldType: row.field_type,
    description: row.description ?? "", groupName: row.group_name ?? groupFor(row.object_type),
    options: (row.options ?? []).map((o, i) => ({ displayOrder: i, hidden: false, ...(o as object) })),
    displayOrder: row.display_order, calculated: false, externalOptions: false,
    hasUniqueValue: row.has_unique_value, hidden: row.hidden, hubspotDefined: row.hubspot_defined,
    modificationMetadata: { archivable: !row.hubspot_defined, readOnlyDefinition: row.hubspot_defined, readOnlyValue: ["hs_object_id", "createdate", "lastmodifieddate", "hs_lastmodifieddate", "hs_createdate"].includes(row.name) },
    formField: row.form_field, dataSensitivity: "non_sensitive",
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), archived: row.archived,
  };
  if (row.archived) out.archivedAt = row.updated_at.toISOString();
  return out;
}

async function getProperty(objectType: string, name: string, archived = false): Promise<PropertyRow | undefined> {
  const [row] = await query<PropertyRow>(
    `SELECT ${columns} FROM property_definitions WHERE object_type = $1 AND name = $2 AND archived = $3`, [objectType, name, archived]);
  return row;
}

function validate(body: PropertyBody, creating: boolean): void {
  if (creating) {
    for (const key of ["name", "label", "type", "fieldType", "groupName"] as const) {
      if (!body[key]) throw badRequest(`${key} is required`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(body.name!)) throw badRequest(`Property name ${body.name} is not valid: use lowercase letters, numbers and underscores.`);
  }
  if (body.type && !types.has(body.type)) throw badRequest(`${body.type} is not a valid property type`);
  if (body.fieldType && !fieldTypes.has(body.fieldType)) throw badRequest(`${body.fieldType} is not a valid field type`);
  if (body.type === "enumeration" && creating && !Array.isArray(body.options)) throw badRequest("Enumeration properties need options");
}

const normalizedOptions = (options: PropertyBody["options"]) => (options ?? []).map((o, i) => ({
  label: String(o.label ?? o.value ?? ""), value: String(o.value ?? o.label ?? ""),
  displayOrder: o.displayOrder ?? i, hidden: o.hidden ?? false, description: o.description ?? "",
}));

async function createProperty(objectType: string, body: PropertyBody): Promise<PropertyRow> {
  validate(body, true);
  const existing = await query(`SELECT archived FROM property_definitions WHERE object_type = $1 AND name = $2`, [objectType, body.name]);
  if (existing.length) throw conflict(`A property named '${body.name}' already exists.`);
  const [row] = await query<PropertyRow>(
    `INSERT INTO property_definitions (object_type, name, label, type, field_type, group_name, description, options,
       display_order, has_unique_value, hubspot_defined, form_field, hidden)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, FALSE, $11, $12)
     ON CONFLICT (object_type, name) DO NOTHING RETURNING ${columns}`,
    [objectType, body.name, body.label, body.type, body.fieldType, body.groupName, body.description ?? "",
      JSON.stringify(normalizedOptions(body.options)), body.displayOrder ?? -1, body.hasUniqueValue ?? false,
      body.formField ?? true, body.hidden ?? false]);
  if (!row) throw conflict(`A property named '${body.name}' already exists.`);
  invalidateSchemaCache();
  return row;
}

export function registerPropertyRoutes(app: FastifyInstance): void {
  for (const prefix of prefixes) {
    type P = { objectType: string; propertyName?: string; groupName?: string };

    // ---- groups (registered first: static segment) ----
    app.get(`${prefix}/:objectType/groups`, async (request: FastifyRequest<{ Params: P }>) => {
      const type = typeParam(request.params.objectType);
      const rows = await query<{ name: string; label: string; display_order: number; archived: boolean }>(
        `SELECT name, label, display_order, archived FROM property_groups WHERE object_type = $1 AND archived = FALSE ORDER BY display_order, name`, [type]);
      return { results: rows.map((g) => ({ name: g.name, label: g.label, displayOrder: g.display_order, archived: g.archived })) };
    });
    app.get(`${prefix}/:objectType/groups/:groupName`, async (request: FastifyRequest<{ Params: P }>) => {
      const type = typeParam(request.params.objectType);
      const [g] = await query<{ name: string; label: string; display_order: number; archived: boolean }>(
        `SELECT name, label, display_order, archived FROM property_groups WHERE object_type = $1 AND name = $2 AND archived = FALSE`, [type, request.params.groupName]);
      if (!g) throw notFound(`Property group ${request.params.groupName} does not exist.`);
      return { name: g.name, label: g.label, displayOrder: g.display_order, archived: g.archived };
    });
    app.post(`${prefix}/:objectType/groups`, async (request: FastifyRequest<{ Params: P; Body: { name?: string; label?: string; displayOrder?: number } }>, reply) => {
      const type = typeParam(request.params.objectType);
      const { name, label, displayOrder = -1 } = request.body ?? {};
      if (!name || !label) throw badRequest("name and label are required");
      const [g] = await query<{ name: string }>(
        `INSERT INTO property_groups (object_type, name, label, display_order) VALUES ($1, $2, $3, $4)
         ON CONFLICT (object_type, name) DO NOTHING RETURNING name`, [type, name, label, displayOrder]);
      if (!g) throw conflict(`A property group named '${name}' already exists.`);
      return reply.code(201).send({ name, label, displayOrder, archived: false });
    });
    app.patch(`${prefix}/:objectType/groups/:groupName`, async (request: FastifyRequest<{ Params: P; Body: { label?: string; displayOrder?: number } }>) => {
      const type = typeParam(request.params.objectType);
      const [g] = await query<{ name: string; label: string; display_order: number }>(
        `UPDATE property_groups SET label = coalesce($3, label), display_order = coalesce($4, display_order)
         WHERE object_type = $1 AND name = $2 AND archived = FALSE RETURNING name, label, display_order`,
        [type, request.params.groupName, request.body?.label ?? null, request.body?.displayOrder ?? null]);
      if (!g) throw notFound(`Property group ${request.params.groupName} does not exist.`);
      return { name: g.name, label: g.label, displayOrder: g.display_order, archived: false };
    });
    app.delete(`${prefix}/:objectType/groups/:groupName`, async (request: FastifyRequest<{ Params: P }>, reply) => {
      const type = typeParam(request.params.objectType);
      await query(`UPDATE property_groups SET archived = TRUE WHERE object_type = $1 AND name = $2`, [type, request.params.groupName]);
      return reply.code(204).send();
    });

    // ---- batch ----
    app.post(`${prefix}/:objectType/batch/create`, async (request: FastifyRequest<{ Params: P; Body: { inputs?: PropertyBody[] } }>, reply) => {
      const startedAt = new Date().toISOString();
      const type = typeParam(request.params.objectType);
      const results: unknown[] = [];
      for (const input of request.body?.inputs ?? []) results.push(toApi(await createProperty(type, input)));
      return reply.code(201).send({ status: "COMPLETE", results, startedAt, completedAt: new Date().toISOString() });
    });
    app.post(`${prefix}/:objectType/batch/read`, async (request: FastifyRequest<{ Params: P; Body: { inputs?: Array<{ name?: string }>; archived?: boolean } }>) => {
      const startedAt = new Date().toISOString();
      const type = typeParam(request.params.objectType);
      const names = (request.body?.inputs ?? []).map((i) => String(i.name ?? ""));
      const rows = await query<PropertyRow>(`SELECT ${columns} FROM property_definitions WHERE object_type = $1 AND name = ANY($2) AND archived = $3`, [type, names, request.body?.archived ?? false]);
      return { status: "COMPLETE", results: rows.map(toApi), startedAt, completedAt: new Date().toISOString() };
    });
    app.post(`${prefix}/:objectType/batch/archive`, async (request: FastifyRequest<{ Params: P; Body: { inputs?: Array<{ name?: string }> } }>, reply) => {
      const type = typeParam(request.params.objectType);
      const names = (request.body?.inputs ?? []).map((i) => String(i.name ?? ""));
      await query(`UPDATE property_definitions SET archived = TRUE, updated_at = NOW() WHERE object_type = $1 AND name = ANY($2) AND hubspot_defined = FALSE`, [type, names]);
      invalidateSchemaCache();
      return reply.code(204).send();
    });

    // ---- properties ----
    app.get(`${prefix}/:objectType`, async (request: FastifyRequest<{ Params: P; Querystring: { archived?: string; properties?: string } }>) => {
      const type = typeParam(request.params.objectType);
      const rows = await query<PropertyRow>(
        `SELECT ${columns} FROM property_definitions WHERE object_type = $1 AND archived = $2 ORDER BY name`,
        [type, request.query.archived === "true"]);
      return { results: rows.map(toApi) };
    });
    app.get(`${prefix}/:objectType/:propertyName`, async (request: FastifyRequest<{ Params: P; Querystring: { archived?: string } }>) => {
      const type = typeParam(request.params.objectType);
      const row = await getProperty(type, request.params.propertyName!, request.query.archived === "true");
      if (!row) throw notFound(`Unable to find property ${request.params.propertyName} for object type ${type}.`);
      return toApi(row);
    });
    app.post(`${prefix}/:objectType`, async (request: FastifyRequest<{ Params: P; Body: PropertyBody }>, reply) => {
      const type = typeParam(request.params.objectType);
      return reply.code(201).send(toApi(await createProperty(type, request.body ?? {})));
    });
    app.patch(`${prefix}/:objectType/:propertyName`, async (request: FastifyRequest<{ Params: P; Body: PropertyBody }>) => {
      const type = typeParam(request.params.objectType);
      const body = request.body ?? {};
      validate(body, false);
      const current = await getProperty(type, request.params.propertyName!);
      if (!current) throw notFound(`Unable to find property ${request.params.propertyName} for object type ${type}.`);
      if (current.hubspot_defined && (body.type || body.fieldType)) {
        throw new ApiError(400, "VALIDATION_ERROR", `Cannot change the type of HubSpot-defined property ${current.name}.`);
      }
      const row = await withTransaction(async (client) => {
        const [updated] = await query<PropertyRow>(
          `UPDATE property_definitions SET label = coalesce($3, label), type = coalesce($4, type), field_type = coalesce($5, field_type),
             group_name = coalesce($6, group_name), description = coalesce($7, description),
             options = coalesce($8::jsonb, options), display_order = coalesce($9, display_order),
             has_unique_value = coalesce($10, has_unique_value), hidden = coalesce($11, hidden),
             form_field = coalesce($12, form_field), updated_at = NOW()
           WHERE object_type = $1 AND name = $2 RETURNING ${columns}`,
          [type, current.name, body.label ?? null, body.type ?? null, body.fieldType ?? null, body.groupName ?? null,
            body.description ?? null, body.options ? JSON.stringify(normalizedOptions(body.options)) : null,
            body.displayOrder ?? null, body.hasUniqueValue ?? null, body.hidden ?? null, body.formField ?? null], client);
        return updated!;
      });
      invalidateSchemaCache();
      return toApi(row);
    });
    app.delete(`${prefix}/:objectType/:propertyName`, async (request: FastifyRequest<{ Params: P }>, reply) => {
      const type = typeParam(request.params.objectType);
      const current = await getProperty(type, request.params.propertyName!);
      if (!current) throw notFound(`Unable to find property ${request.params.propertyName} for object type ${type}.`);
      if (current.hubspot_defined) throw new ApiError(400, "VALIDATION_ERROR", `HubSpot-defined property ${current.name} cannot be archived.`);
      await query(`UPDATE property_definitions SET archived = TRUE, updated_at = NOW() WHERE object_type = $1 AND name = $2`, [type, current.name]);
      invalidateSchemaCache();
      return reply.code(204).send();
    });
  }
}
