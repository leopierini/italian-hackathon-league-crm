import type { PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Model } from "./model.js";

// COPY text format: backslash, tab, newline and CR must be escaped. JSON.stringify already
// escapes control characters inside strings, so only backslashes need doubling.
const escapeCopy = (value: string) => value.replace(/\\/g, "\\\\");

function* chunks<T>(items: T[], render: (item: T) => string, size = 5000): Generator<string> {
  for (let start = 0; start < items.length; start += size) {
    let out = "";
    const end = Math.min(items.length, start + size);
    for (let i = start; i < end; i += 1) out += render(items[i]!);
    yield out;
  }
}

// COPY into a table that maintains its indexes row by row is slow (1.4M associations: 15 s). Drop
// the secondary indexes and unique constraints, load, rebuild them once. If anything prevents the
// drop (e.g. a foreign key depends on a constraint), fall back to loading with indexes in place.
async function withoutSecondaryIndexes(client: PoolClient, table: string, load: () => Promise<void>): Promise<void> {
  const { rows: constraints } = await client.query<{ name: string; def: string }>(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'u'`,
    [table]);
  const { rows: indexes } = await client.query<{ name: string; def: string }>(
    `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
     WHERE x.indrelid = $1::regclass AND NOT x.indisprimary
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)`,
    [table]);
  await client.query("SAVEPOINT drop_indexes");
  try {
    for (const c of constraints) await client.query(`ALTER TABLE ${table} DROP CONSTRAINT "${c.name}"`);
    for (const i of indexes) await client.query(`DROP INDEX "${i.name}"`);
    await client.query("RELEASE SAVEPOINT drop_indexes");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT drop_indexes");
    await load();
    return;
  }
  await load();
  await client.query("SET LOCAL maintenance_work_mem = '256MB'");
  for (const i of indexes) {
    // A unique index the data would violate must not fail the whole migration: skip it (the API
    // still checks uniqueness under an advisory lock).
    await client.query("SAVEPOINT rebuild_index");
    try {
      await client.query(i.def);
      await client.query("RELEASE SAVEPOINT rebuild_index");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT rebuild_index");
      console.error(`index ${i.name} not rebuilt: ${(error as Error).message}`);
    }
  }
  for (const c of constraints) await client.query(`ALTER TABLE ${table} ADD CONSTRAINT "${c.name}" ${c.def}`);
}

export async function copyModel(
  client: PoolClient, model: Model, createdAt: Map<number, string>, step: (name: string) => void = () => {},
): Promise<void> {
  const now = new Date().toISOString();
  await withoutSecondaryIndexes(client, "objects", () => pipeline(
    Readable.from(chunks(model.objects, (obj) => {
      const created = createdAt.get(obj.id) ?? now;
      return `${obj.id}\t${obj.type}\t${escapeCopy(JSON.stringify(obj.props))}\t${created}\t${now}\n`;
    })),
    client.query(copyFrom("COPY objects (id, type, properties, created_at, updated_at) FROM STDIN")),
  ));
  step(`copy objects ${model.objects.length}`);
  await withoutSecondaryIndexes(client, "associations", () => pipeline(
    Readable.from(chunks(model.assocs, ([fromType, fromId, toType, toId, typeId]) =>
      `${fromType}\t${fromId}\t${toType}\t${toId}\t${typeId}\n`)),
    client.query(copyFrom("COPY associations (from_type, from_id, to_type, to_id, type_id) FROM STDIN")),
  ));
  step(`copy associations ${model.assocs.length}`);
  await client.query(`SELECT setval(pg_get_serial_sequence('objects', 'id'), GREATEST((SELECT MAX(id) FROM objects), 1))`);
}

// A static (MANUAL) list with fixed members, e.g. R9 "Clienti dormienti".
export async function createStaticList(client: PoolClient, name: string, objectTypeId: string, recordIds: number[]): Promise<void> {
  const { rows: [list] } = await client.query<{ id: string }>(
    `INSERT INTO lists (name, object_type_id, processing_type) VALUES ($1, $2, 'MANUAL') RETURNING id`,
    [name, objectTypeId],
  );
  await client.query(
    `INSERT INTO list_memberships (list_id, record_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`,
    [list!.id, recordIds],
  );
}
