import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { defaultGroups, defaultPropertySeeds } from "./api/schema.js";

export type Db = Pool | PoolClient;

type Stage = { id: string; label: string; displayOrder: number; probability?: number; closed: boolean; metadata: Record<string, string> };

const dealStage = (id: string, label: string, displayOrder: number, probability: number, closed: boolean): Stage => ({
  id, label, displayOrder, probability, closed,
  metadata: { isClosed: String(closed), probability: String(probability) },
});
const ticketStage = (id: string, label: string, displayOrder: number, closed: boolean): Stage => ({
  id, label, displayOrder, closed,
  metadata: { ticketState: closed ? "CLOSED" : "OPEN", isClosed: String(closed) },
});

const defaultPipelines = [
  {
    objectType: "deals", id: "default", label: "Sales Pipeline", displayOrder: 0,
    stages: [
      dealStage("appointmentscheduled", "Appointment Scheduled", 0, 0.2, false),
      dealStage("qualifiedtobuy", "Qualified To Buy", 1, 0.4, false),
      dealStage("presentationscheduled", "Presentation Scheduled", 2, 0.6, false),
      dealStage("decisionmakerboughtin", "Decision Maker Bought-In", 3, 0.8, false),
      dealStage("contractsent", "Contract Sent", 4, 0.9, false),
      dealStage("closedwon", "Closed Won", 5, 1, true),
      dealStage("closedlost", "Closed Lost", 6, 0, true),
    ],
  },
  {
    objectType: "tickets", id: "0", label: "Support Pipeline", displayOrder: 0,
    stages: [
      ticketStage("1", "New", 0, false),
      ticketStage("2", "Waiting on contact", 1, false),
      ticketStage("3", "Waiting on us", 2, false),
      ticketStage("4", "Closed", 3, true),
    ],
  },
];

// HubSpot-defined association types (v4 ids), both directions: [from, to, typeId, inverseTypeId, label].
const assocSeed: Array<[string, string, number, number, string | null]> = [
  ["contacts", "companies", 279, 280, null], ["contacts", "companies", 1, 2, "Primary"],
  ["deals", "companies", 341, 342, null], ["deals", "companies", 5, 6, "Primary"],
  ["deals", "contacts", 3, 4, null],
  ["tickets", "contacts", 16, 15, null],
  ["tickets", "companies", 339, 340, null], ["tickets", "companies", 26, 25, "Primary"],
  ["tickets", "deals", 28, 27, null],
  ["line_items", "deals", 20, 19, null],
  ["notes", "contacts", 202, 201, null], ["notes", "companies", 190, 189, null], ["notes", "deals", 214, 213, null], ["notes", "tickets", 228, 227, null],
  ["calls", "contacts", 194, 193, null], ["calls", "companies", 182, 181, null], ["calls", "deals", 206, 205, null], ["calls", "tickets", 220, 219, null],
  ["emails", "contacts", 198, 197, null], ["emails", "companies", 186, 185, null], ["emails", "deals", 210, 209, null], ["emails", "tickets", 224, 223, null],
  ["meetings", "contacts", 200, 199, null], ["meetings", "companies", 188, 187, null], ["meetings", "deals", 212, 211, null], ["meetings", "tickets", 226, 225, null],
  ["tasks", "contacts", 204, 203, null], ["tasks", "companies", 192, 191, null], ["tasks", "deals", 216, 215, null], ["tasks", "tickets", 230, 229, null],
];
const inverseLabel: Record<string, string> = {};
const defaultAssociationTypes = assocSeed.flatMap(([from, to, typeId, inverse, label]) => [
  { from, to, typeId: String(typeId), inverse: String(inverse), label },
  { from: to, to: from, typeId: String(inverse), inverse: String(typeId), label: label ? inverseLabel[label] ?? label : null },
]);

let pool: Pool | undefined;

export function db(): Pool {
  if (!pool) throw new Error("Storage has not been initialized");
  return pool;
}

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string, values: unknown[] = [], client: Db = db(),
): Promise<T[]> {
  const result = await client.query<T>(sql, values);
  return result.rows;
}

async function seedDefaults(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO property_definitions
       (object_type, name, label, type, field_type, group_name, options, hubspot_defined, has_unique_value)
     SELECT x."objectType", x.name, x.label, x.type, x."fieldType", x."groupName", x.options, TRUE, FALSE
     FROM jsonb_to_recordset($1::jsonb) AS x("objectType" text, name text, label text, type text,
       "fieldType" text, "groupName" text, options jsonb)
     ON CONFLICT (object_type, name) DO NOTHING`,
    [JSON.stringify(defaultPropertySeeds)],
  );
  await client.query(
    `INSERT INTO property_groups (object_type, name, label, display_order)
     SELECT x."objectType", x.name, x.label, 0 FROM jsonb_to_recordset($1::jsonb) AS x("objectType" text, name text, label text)
     ON CONFLICT (object_type, name) DO NOTHING`,
    [JSON.stringify(defaultGroups)],
  );
  await client.query(
    `INSERT INTO pipelines (object_type, pipeline_id, label, stages, display_order)
     SELECT x."objectType", x.id, x.label, x.stages, x."displayOrder"
     FROM jsonb_to_recordset($1::jsonb) AS x("objectType" text, id text, label text, stages jsonb, "displayOrder" int)
     ON CONFLICT (object_type, pipeline_id) DO NOTHING`,
    [JSON.stringify(defaultPipelines)],
  );
  await client.query(
    `INSERT INTO association_types (from_object_type, to_object_type, type_id, inverse_type_id, label, category)
     SELECT x."from", x."to", x."typeId", x.inverse, x.label, 'HUBSPOT_DEFINED'
     FROM jsonb_to_recordset($1::jsonb) AS x("from" text, "to" text, "typeId" text, inverse text, label text)
     ON CONFLICT (from_object_type, to_object_type, type_id) DO NOTHING`,
    [JSON.stringify(defaultAssociationTypes)],
  );
}

// Unique indexes are created separately: on a database that already holds duplicates they fail,
// and the service must still start (the API also checks uniqueness under an advisory lock).
const uniqueIndexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS objects_company_vat_uq ON objects ((properties->>'partita_iva'))
     WHERE type = 'companies' AND archived = FALSE`,
  `CREATE UNIQUE INDEX IF NOT EXISTS objects_contact_email_uq ON objects (lower(properties->>'email'))
     WHERE type = 'contacts' AND archived = FALSE`,
];

export async function initializeStore(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  pool = new Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000 });

  await db().query(`
    CREATE TABLE IF NOT EXISTS objects (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      type TEXT NOT NULL,
      properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (type, id)
    );
    CREATE INDEX IF NOT EXISTS objects_type_id_idx ON objects (type, id);
    CREATE INDEX IF NOT EXISTS objects_type_archived_idx ON objects (type, archived);
    CREATE INDEX IF NOT EXISTS objects_legacy_idx ON objects (type, lower(properties->>'id_legacy'));
    CREATE INDEX IF NOT EXISTS objects_company_domain_idx ON objects (lower(properties->>'domain'))
      WHERE type = 'companies';

    CREATE TABLE IF NOT EXISTS associations (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      from_type TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_type TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (from_type, from_id, to_type, to_id, type_id)
    );
    CREATE INDEX IF NOT EXISTS associations_from_idx ON associations (from_type, from_id);
    CREATE INDEX IF NOT EXISTS associations_to_idx ON associations (to_type, to_id);

    CREATE TABLE IF NOT EXISTS property_definitions (
      object_type TEXT NOT NULL,
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      field_type TEXT NOT NULL,
      has_unique_value BOOLEAN NOT NULL DEFAULT FALSE,
      options JSONB NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (object_type, name)
    );
    ALTER TABLE property_definitions
      ADD COLUMN IF NOT EXISTS group_name TEXT,
      ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT -1,
      ADD COLUMN IF NOT EXISTS hubspot_defined BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS form_field BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE TABLE IF NOT EXISTS property_groups (
      object_type TEXT NOT NULL,
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      display_order INT NOT NULL DEFAULT -1,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (object_type, name)
    );
    CREATE TABLE IF NOT EXISTS pipelines (
      object_type TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      label TEXT NOT NULL,
      stages JSONB NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (object_type, pipeline_id)
    );
    ALTER TABLE pipelines
      ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE TABLE IF NOT EXISTS association_types (
      from_object_type TEXT NOT NULL,
      to_object_type TEXT NOT NULL,
      type_id TEXT NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY (from_object_type, to_object_type, type_id)
    );
    ALTER TABLE association_types
      ALTER COLUMN label DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS inverse_type_id TEXT,
      ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'HUBSPOT_DEFINED';
    CREATE TABLE IF NOT EXISTS rate_limit_counters (
      counter_key TEXT PRIMARY KEY,
      count BIGINT NOT NULL DEFAULT 0
    );
    -- R10/R11: one automation per deal and kind, ever (until reset).
    CREATE TABLE IF NOT EXISTS automation_runs (
      deal_id BIGINT NOT NULL,
      kind TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (deal_id, kind)
    );
    -- Lists API. object_type_id uses HubSpot ids (0-1 contacts, 0-2 companies, 0-3 deals);
    -- processing_type MANUAL | DYNAMIC | SNAPSHOT.
    CREATE TABLE IF NOT EXISTS lists (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      object_type_id TEXT NOT NULL,
      processing_type TEXT NOT NULL DEFAULT 'MANUAL',
      filter_branch JSONB,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS list_memberships (
      list_id BIGINT NOT NULL,
      record_id BIGINT NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (list_id, record_id)
    );
    ALTER TABLE lists
      ADD COLUMN IF NOT EXISTS list_version INT NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS filters_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS list_memberships_record_idx ON list_memberships (record_id);
    -- Brambilla users (utenti.csv), written by the migration: the assistant's directory of who
    -- writes, who is active and who follows what.
    CREATE TABLE IF NOT EXISTS crm_users (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      manager_id TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    -- Exports API: the CSV is built in the background and served by a token link (no bearer).
    CREATE TABLE IF NOT EXISTS exports (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      request JSONB NOT NULL,
      state TEXT NOT NULL DEFAULT 'PROCESSING',
      token TEXT NOT NULL,
      record_count INT,
      file TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Lenient casts for search on property values stored as text.
    CREATE OR REPLACE FUNCTION crm_num(t text) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN t ~ '^\\s*-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?\\s*$' THEN t::numeric END
    $$;
    CREATE OR REPLACE FUNCTION crm_ms(t text) RETURNS double precision LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF t IS NULL OR t = '' THEN RETURN NULL; END IF;
      IF t ~ '^-?[0-9]+$' THEN RETURN t::double precision; END IF;
      RETURN extract(epoch FROM t::timestamptz) * 1000;
    EXCEPTION WHEN others THEN RETURN NULL;
    END $$;

    -- R12: a company's sites (domain + hs_additional_domains) as bare hosts, indexed for lookup by
    -- contact email domain. "https://www.x.it/path" -> "x.it". Schema-qualified: index builds run
    -- with search_path = pg_catalog (Postgres 17).
    CREATE OR REPLACE FUNCTION crm_domain(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT NULLIF(regexp_replace(lower(trim(t)), '^([a-z][a-z0-9+.-]*://)?(www\\.)?([^/:?#[:space:]]+).*$', '\\3'), '')
    $$;
    CREATE OR REPLACE FUNCTION crm_domains(p jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
      SELECT coalesce(array_agg(DISTINCT d) FILTER (WHERE d IS NOT NULL), '{}'::text[]) FROM (
        SELECT public.crm_domain(v) AS d
        FROM unnest(array_prepend(p->>'domain', string_to_array(coalesce(p->>'hs_additional_domains', ''), ';'))) AS u(v)
      ) x
    $$;
    CREATE INDEX IF NOT EXISTS objects_company_domains_idx ON objects USING gin (crm_domains(properties))
      WHERE type = 'companies';
  `);
  for (const sql of uniqueIndexes) {
    try {
      await db().query(sql);
    } catch (error) {
      console.error(`unique index not created: ${(error as Error).message}`);
    }
  }

  const client = await db().connect();
  try {
    await seedDefaults(client);
  } finally {
    client.release();
  }
}

export async function closeStore(): Promise<void> {
  if (!pool) return;
  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}

const resetListeners: Array<() => void> = [];
export function onReset(listener: () => void): void {
  resetListeners.push(listener);
}

export async function resetStore(): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE TABLE
      objects, associations, property_definitions, property_groups, pipelines, association_types,
      rate_limit_counters, automation_runs, lists, list_memberships, exports, crm_users
      RESTART IDENTITY CASCADE`);
    await seedDefaults(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  for (const listener of resetListeners) listener();
}

export async function analyzeStore(): Promise<void> {
  await db().query("ANALYZE objects, associations, list_memberships");
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function incrementRateLimitCounter(key: string): Promise<number> {
  const [row] = await query<{ count: string }>(
    `INSERT INTO rate_limit_counters (counter_key, count) VALUES ($1, 1)
     ON CONFLICT (counter_key) DO UPDATE SET count = rate_limit_counters.count + 1
     RETURNING count`, [key]);
  if (!row) throw new Error("Rate counter insert returned no row");
  return Number(row.count);
}
