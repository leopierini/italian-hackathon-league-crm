import { performance } from "node:perf_hooks";

const crmUrl = process.env.CRM_URL?.replace(/\/$/, "");
const token = process.env.CRM_TOKEN;
// KEEP_DATA=1 skips reset and migrate: API checks on the data already there (no re-migration).
const keepData = process.env.KEEP_DATA === "1";
let failures = 0;

function report(name: string, pass: boolean, value: string, startedAt: number): void {
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${value} (${elapsedMs} ms)`);
  if (!pass) failures += 1;
}

function skipped(name: string, value: string): void {
  console.log(`SKIP ${name}: ${value} (0 ms)`);
}

async function request(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  if (!crmUrl) throw new Error("CRM_URL is required");
  return fetch(`${crmUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function run(): Promise<void> {
  if (!crmUrl) {
    report("config", false, "CRM_URL is required", performance.now());
    process.exitCode = 1;
    return;
  }
  if (!token) {
    report("config", false, "CRM_TOKEN is required", performance.now());
    process.exitCode = 1;
    return;
  }

  let healthOk = false;
  const healthStarted = performance.now();
  try {
    const response = await request("/health");
    const body = await response.json() as { status?: string; version?: string };
    healthOk = response.status === 200 && body.status === "ok" && body.version === "2026-09";
    report("health", healthOk, `HTTP ${response.status}, version ${body.version ?? "missing"}`, healthStarted);
  } catch (error) {
    report("health", false, error instanceof Error ? error.message : "request failed", healthStarted);
  }

  const unauthorizedStarted = performance.now();
  try {
    const response = await request("/__reset", { method: "POST" });
    report("401 without token", response.status === 401, `HTTP ${response.status}`, unauthorizedStarted);
  } catch (error) {
    report("401 without token", false, error instanceof Error ? error.message : "request failed", unauthorizedStarted);
  }

  const resetStarted = performance.now();
  if (keepData) skipped("reset", "KEEP_DATA=1");
  else try {
    const response = await request("/__reset", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const elapsedMs = performance.now() - resetStarted;
    report("reset", response.status === 204 && elapsedMs < 500,
      `HTTP ${response.status}, ${Math.round(elapsedMs)} ms (limit 500 ms)`, resetStarted);
  } catch (error) {
    report("reset", false, error instanceof Error ? error.message : "request failed", resetStarted);
  }

  if (process.env.EXPORT_URL && !keepData) {
    const migrateStarted = performance.now();
    try {
      const response = await request("/__migrate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ export_url: process.env.EXPORT_URL }),
      }, 300_000);
      const elapsedMs = performance.now() - migrateStarted;
      report("migrate", response.status === 204 && elapsedMs < 300_000,
        `HTTP ${response.status}, ${Math.round(elapsedMs)} ms (limit 300000 ms)`, migrateStarted);

      const maxTotals: Record<string, number> = {
        companies: 19_698,
        contacts: 70_589,
        deals: 33_577,
        products: 1_852,
        line_items: 41_014,
        tickets: 21_329,
        notes: 143_410,
        calls: 107_761,
        emails: 72_232,
        meetings: 36_200,
      };
      if (response.status === 204) {
        for (const [objectType, maximum] of Object.entries(maxTotals)) {
          const countStarted = performance.now();
          try {
            const countResponse = await request(
              `/crm/objects/2026-09/${objectType}/search`,
              {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ limit: 1 }),
              },
            );
            const body = await countResponse.json() as { total?: number };
            const total = Number(body.total);
            const pass = countResponse.ok && Number.isFinite(total) && total <= maximum;
            report(`count ${objectType}`, pass,
              `HTTP ${countResponse.status}, total ${Number.isFinite(total) ? total : "missing"}, max ${maximum}`,
              countStarted);
          } catch (error) {
            report(`count ${objectType}`, false,
              error instanceof Error ? error.message : "request failed", countStarted);
          }
        }
      }
    } catch (error) {
      report("migrate", false, error instanceof Error ? error.message : "request failed", migrateStarted);
    }
  } else {
    skipped("migrate and totals", "set EXPORT_URL to run migration and count bounds");
  }

  const agentStarted = performance.now();
  try {
    const response = await request("/__agente", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-crm-check-model": process.env.REAL_MODEL === "1" ? "real" : "mock",
      },
      body: JSON.stringify({
        context: { now: new Date().toISOString(), user: "check@example.invalid" },
        messages: [{ role: "user", content: "Rispondi con un saluto breve." }],
      }),
    }, 60_000);
    const body = await response.json() as { reply?: unknown };
    report("agente", response.status === 200 && typeof body.reply === "string",
      `HTTP ${response.status}, reply ${typeof body.reply === "string" ? "string" : "missing"}`,
      agentStarted);
  } catch (error) {
    report("agente", false, error instanceof Error ? error.message : "request failed", agentStarted);
  }

  await apiChecks();

  process.exitCode = failures === 0 ? 0 : 1;
}

type Json = Record<string, any>;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

async function check(name: string, fn: () => Promise<[boolean, string]>): Promise<void> {
  const started = performance.now();
  try {
    const [pass, value] = await fn();
    report(name, pass, value, started);
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : "request failed", started);
  }
}

// 3.2 CRUD per object type, 3.7 R7, 3.8 R10, 3.9 R11 through the public API.
async function apiChecks(): Promise<void> {
  const stamp = Date.now();
  const at = new Date().toISOString();
  const samples: Record<string, [Json, Json]> = {
    contacts: [{ email: `check-${stamp}@example.invalid`, firstname: "Check" }, { lastname: "Patched" }],
    companies: [{ name: `Check ${stamp}` }, { city: "Torino" }],
    deals: [{ dealname: `Check ${stamp}`, dealstage: "appointmentscheduled", pipeline: "default" }, { amount: "10" }],
    tickets: [{ subject: `Check ${stamp}`, hs_pipeline: "0", hs_pipeline_stage: "1" }, { content: "patched" }],
    products: [{ name: `Check ${stamp}`, price: "1" }, { price: "2" }],
    line_items: [{ name: `Check ${stamp}`, quantity: "1", price: "1" }, { quantity: "2" }],
    notes: [{ hs_note_body: "Check", hs_timestamp: at }, { hs_note_body: "patched" }],
    calls: [{ hs_call_body: "Check", hs_timestamp: at }, { hs_call_body: "patched" }],
    emails: [{ hs_email_subject: "Check", hs_timestamp: at }, { hs_email_subject: "patched" }],
    meetings: [{ hs_meeting_title: "Check", hs_timestamp: at }, { hs_meeting_title: "patched" }],
    tasks: [{ hs_task_subject: "Check", hs_timestamp: at, hs_task_status: "NOT_STARTED" }, { hs_task_subject: "patched" }],
  };
  for (const [type, [create, patch]] of Object.entries(samples)) {
    await check(`crud ${type}`, async () => {
      const base = `/crm/objects/2026-09/${type}`;
      const created = await api("POST", base, { properties: create });
      const id = created.body.id;
      const shapeOk = typeof id === "string" && !Number.isNaN(Date.parse(created.body.createdAt))
        && created.body.properties?.hs_object_id === id;
      const got = await api("GET", `${base}/${id}`);
      const patched = await api("PATCH", `${base}/${id}`, { properties: patch });
      const [key, value] = Object.entries(patch)[0]!;
      const reread = await api("GET", `${base}/${id}?properties=${key}`);
      const removed = await api("DELETE", `${base}/${id}`);
      const gone = await api("GET", `${base}/${id}`);
      const statuses = [created.status, got.status, patched.status, removed.status, gone.status].join("/");
      const pass = statuses === "201/200/200/204/404" && shapeOk && reread.body.properties?.[key] === value
        && gone.body.category === "OBJECT_NOT_FOUND";
      return [pass, `statuses ${statuses} (expect 201/200/200/204/404), shape ${shapeOk ? "ok" : "bad"}`];
    });
  }

  const vatDefined = (await api("GET", "/crm/properties/2026-09/companies/partita_iva")).status === 200;
  if (!vatDefined) {
    skipped("R7 409", "partita_iva not defined (run after migrate)");
  } else {
    await check("R7 409", async () => {
      const vat = String(stamp).slice(-11).padStart(11, "7");
      const first = await api("POST", "/crm/objects/2026-09/companies", { properties: { name: "R7 a", partita_iva: vat } });
      const second = await api("POST", "/crm/objects/2026-09/companies", { properties: { name: "R7 b", partita_iva: `IT ${vat}` } });
      const parallelVat = String(stamp + 1).slice(-11).padStart(11, "8");
      const parallel = await Promise.all(Array.from({ length: 10 }, () =>
        api("POST", "/crm/objects/2026-09/companies", { properties: { name: "R7 p", partita_iva: parallelVat } })));
      const created = parallel.filter((r) => r.status === 201).length;
      const conflicts = parallel.filter((r) => r.status === 409).length;
      const pass = first.status === 201 && second.status === 409 && created === 1 && conflicts === 9;
      return [pass, `create ${first.status}, duplicate ${second.status}, parallel ${created}x201 ${conflicts}x409`];
    });
  }

  const ticketsOf = async (dealId: string) => (await api("GET", `/crm/objects/2026-09/deals/${dealId}/associations/tickets`)).body.results ?? [];
  const tasksOf = async (dealId: string) => (await api("GET", `/crm/objects/2026-09/deals/${dealId}/associations/tasks`)).body.results ?? [];
  const company = await api("POST", "/crm/objects/2026-09/companies", { properties: { name: `R10 ${stamp}` } });
  for (const [rule, stage, back] of [["R10 won ticket", "closedwon", "contractsent"], ["R11 lost task", "closedlost", "contractsent"]] as const) {
    await check(rule, async () => {
      const moved = await api("POST", "/crm/objects/2026-09/deals", {
        properties: { dealname: `${rule} ${stamp}`, dealstage: "appointmentscheduled", pipeline: "default", commerciale: "check@example.invalid" },
        associations: [{ to: { id: company.body.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 341 }] }],
      });
      const entered = Date.now();
      for (const s of [stage, back, stage]) await api("PATCH", `/crm/objects/2026-09/deals/${moved.body.id}`, { properties: { dealstage: s } });
      const direct = await api("POST", "/crm/objects/2026-09/deals", { properties: { dealname: `${rule} direct ${stamp}`, dealstage: stage } });
      const links = stage === "closedwon" ? ticketsOf : tasksOf;
      const [a, b] = [await links(moved.body.id), await links(direct.body.id)];
      let detail = "";
      let fieldsOk = false;
      if (a.length === 1) {
        if (stage === "closedwon") {
          const t = await api("GET", `/crm/objects/2026-09/tickets/${a[0].toObjectId}?properties=subject,hs_pipeline,hs_pipeline_stage,assegnatario&associations=companies`);
          const p = t.body.properties ?? {};
          fieldsOk = p.subject === `Avvio fornitura - ${rule} ${stamp}` && p.hs_pipeline === "Assistenza" && p.hs_pipeline_stage === "Aperto"
            && p.assegnatario === "check@example.invalid" && t.body.associations?.companies?.results?.[0]?.id === company.body.id;
          detail = `${p.subject} / ${p.hs_pipeline} / ${p.hs_pipeline_stage} / ${p.assegnatario}`;
        } else {
          const t = await api("GET", `/crm/objects/2026-09/tasks/${a[0].toObjectId}?properties=hs_task_subject,hs_timestamp,hs_task_status`);
          const p = t.body.properties ?? {};
          const due = Date.parse(p.hs_timestamp) - entered;
          fieldsOk = p.hs_task_subject === `Richiamare: ${rule} ${stamp}` && p.hs_task_status === "NOT_STARTED"
            && Math.abs(due - 180 * 86_400_000) < 60_000;
          detail = `${p.hs_task_subject} / due ${p.hs_timestamp} / ${p.hs_task_status}`;
        }
      }
      return [a.length === 1 && b.length === 1 && fieldsOk, `moved deal ${a.length}, direct deal ${b.length} (expect 1/1); ${detail}`];
    });
  }

  // 3.11 Lists: R9 list paged in full, a MANUAL list edited by hand, a DYNAMIC list following a property.
  const lists = "/crm/lists/2026-09";
  const dormant = (await api("POST", `${lists}/search`, { query: "Clienti dormienti" })).body.lists?.[0];
  if (!dormant) {
    skipped("lists R9", "Clienti dormienti not found (run after migrate)");
  } else {
    await check("lists R9", async () => {
      const seen = new Set<string>();
      let after: string | undefined;
      let pages = 0;
      do {
        const page = await api("GET", `${lists}/${dormant.listId}/memberships?limit=100${after ? `&after=${after}` : ""}`);
        for (const r of page.body.results ?? []) seen.add(r.recordId);
        after = page.body.paging?.next?.after;
        pages += 1;
      } while (after && pages < 1000);
      const byName = await api("GET", `${lists}/object-type-id/0-2/name/${encodeURIComponent("Clienti dormienti")}`);
      const pass = seen.size === dormant.size && seen.size > 0 && byName.body.list?.listId === dormant.listId;
      return [pass, `${seen.size} members in ${pages} pages, size ${dormant.size}, by name ${byName.status}`];
    });
  }
  await check("lists manual + dynamic", async () => {
    const c1 = await api("POST", "/crm/objects/2026-09/contacts", { properties: { email: `list1-${stamp}@example.invalid` } });
    const c2 = await api("POST", "/crm/objects/2026-09/contacts", { properties: { email: `list2-${stamp}@example.invalid` } });
    const manual = await api("POST", lists, { name: `Manual ${stamp}`, objectTypeId: "0-1", processingType: "MANUAL" });
    const id = manual.body.list?.listId;
    const added = await api("PUT", `${lists}/${id}/memberships/add`, [c1.body.id, c2.body.id, "999999999999"]);
    const removed = await api("PUT", `${lists}/${id}/memberships/remove`, [c2.body.id]);
    const members = (await api("GET", `${lists}/${id}/memberships`)).body.results?.map((r: Json) => r.recordId) ?? [];
    const duplicate = await api("POST", lists, { name: `Manual ${stamp}`, objectTypeId: "0-1", processingType: "MANUAL" });
    const city = `Dyn${stamp}`;
    const company = await api("POST", "/crm/objects/2026-09/companies", { properties: { name: `Dyn ${stamp}`, city } });
    const dynamic = await api("POST", lists, {
      name: `Dynamic ${stamp}`, objectTypeId: "0-2", processingType: "DYNAMIC",
      filterBranch: { filterBranchType: "OR", filters: [], filterBranches: [{ filterBranchType: "AND", filterBranches: [], filters: [
        { filterType: "PROPERTY", property: "city", operation: { operationType: "MULTISTRING", operator: "IS_EQUAL_TO", values: [city.toLowerCase()] } },
      ] }] },
    });
    const dynId = dynamic.body.list?.listId;
    const before = (await api("GET", `${lists}/${dynId}/memberships`)).body.results?.map((r: Json) => r.recordId) ?? [];
    await api("PATCH", `/crm/objects/2026-09/companies/${company.body.id}`, { properties: { city: "Elsewhere" } });
    const afterMove = (await api("GET", `${lists}/${dynId}/memberships`)).body.results?.length ?? -1;
    const deleted = await api("DELETE", `${lists}/${id}`);
    const gone = await api("GET", `${lists}/${id}`);
    const pass = manual.status === 200 && added.body.recordsIdsAdded?.length === 2 && added.body.recordIdsMissing?.length === 1
      && removed.body.recordIdsRemoved?.[0] === c2.body.id && members.length === 1 && members[0] === c1.body.id
      && duplicate.status === 400 && dynamic.status === 200 && before.length === 1 && before[0] === company.body.id && afterMove === 0
      && deleted.status === 204 && gone.status === 404;
    return [pass, `manual create ${manual.status}, add ${added.body.recordsIdsAdded?.length}/missing ${added.body.recordIdsMissing?.length}, members ${members.length}, dup name ${duplicate.status}; dynamic ${dynamic.status} members ${before.length} -> ${afterMove}; delete ${deleted.status} then ${gone.status}`];
  });

  // 3.12 Exports: start, poll status, download `result` without a token.
  await check("export csv", async () => {
    const email = `export-${stamp}@example.invalid`;
    await api("POST", "/crm/objects/2026-09/contacts", { properties: { email, firstname: "Export" } });
    const started = await api("POST", "/crm/exports/2026-09/export/async", {
      exportType: "VIEW", exportName: `check ${stamp}`, format: "CSV", language: "EN", objectType: "CONTACT",
      objectProperties: ["email", "firstname"], exportInternalValuesOptions: ["NAMES"],
      publicCrmSearchRequest: { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] },
    });
    let status: Json = {};
    for (let i = 0; i < 30 && status.status !== "COMPLETE"; i += 1) {
      status = (await api("GET", `/crm/exports/2026-09/export/async/tasks/${started.body.id}/status`)).body;
      if (status.status !== "COMPLETE") await new Promise((r) => setTimeout(r, 500));
    }
    const url = String(status.result ?? "");
    const file = await request(url.startsWith("http") ? url.replace(/^https?:\/\/[^/]+/, "") : url);
    const csv = await file.text();
    const pass = started.status === 202 && status.status === "COMPLETE" && file.status === 200
      && csv.startsWith("hs_object_id,email,firstname") && csv.includes(email);
    return [pass, `start ${started.status}, status ${status.status}, download without token ${file.status}, ${csv.split("\n").length - 2} rows`];
  });

  // 3.13 Errors in HubSpot shape; rate-limit headers counted from zero after /__reset.
  await check("errors + rate headers", async () => {
    const unknownProp = await api("POST", "/crm/objects/2026-09/contacts", { properties: { not_a_property: "x" } });
    const missing = await api("GET", "/crm/objects/2026-09/contacts/999999999999");
    const notJson = await request("/crm/objects/2026-09/contacts", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{oops" });
    const shaped = (b: Json) => b.status === "error" && typeof b.message === "string" && typeof b.correlationId === "string" && typeof b.category === "string";
    const notJsonBody = await notJson.json() as Json;
    let headersOk = true;
    if (!keepData) {
      await request("/__reset", { method: "POST", headers: { authorization: `Bearer ${token}` } });
      const first = await request("/crm/objects/2026-09/contacts?limit=1", { headers: { authorization: `Bearer ${token}` } });
      headersOk = first.headers.get("x-hubspot-ratelimit-max") === "100" && first.headers.get("x-hubspot-ratelimit-remaining") === "99";
    }
    const pass = unknownProp.status === 400 && unknownProp.body.errors?.[0]?.code === "PROPERTY_DOESNT_EXIST" && shaped(unknownProp.body)
      && missing.status === 404 && missing.body.category === "OBJECT_NOT_FOUND" && shaped(missing.body)
      && notJson.status === 400 && shaped(notJsonBody) && headersOk;
    return [pass, `unknown property ${unknownProp.status}, unknown id ${missing.status} ${missing.body.category}, bad JSON ${notJson.status}, rate headers after reset ${keepData ? "skipped" : headersOk ? "ok" : "bad"}`];
  });

  // R12: contacts without a company get the company whose domain (or additional domain) matches.
  await check("R12 email domain", async () => {
    const domain = `r12-${stamp}.example.it`;
    const extra = `r12-alt-${stamp}.example.it`;
    const target = await api("POST", "/crm/objects/2026-09/companies", { properties: { name: `R12 ${stamp}`, domain: `https://www.${domain}/`, hs_additional_domains: `other.example.it;${extra}` } });
    const other = await api("POST", "/crm/objects/2026-09/companies", { properties: { name: `R12 other ${stamp}` } });
    const companiesOf = async (id: string) => ((await api("GET", `/crm/objects/2026-09/contacts/${id}/associations/companies`)).body.results ?? []).map((r: Json) => String(r.toObjectId));
    const single = await api("POST", "/crm/objects/2026-09/contacts", { properties: { email: `A@${domain.toUpperCase()}` } });
    const additional = await api("POST", "/crm/objects/2026-09/contacts", { properties: { email: `b@${extra}` } });
    const unknownDomain = `unknown-${stamp}.example.it`;
    const unknown = await api("POST", "/crm/objects/2026-09/contacts", { properties: { email: `c@${unknownDomain}` } });
    const explicit = await api("POST", "/crm/objects/2026-09/contacts", {
      properties: { email: `d@${domain}` },
      associations: [{ to: { id: other.body.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 279 }] }],
    });
    const batch = await api("POST", "/crm/objects/2026-09/contacts/batch/create", { inputs: [{ properties: { email: `e@${domain}` } }] });
    const upsert = await api("POST", "/crm/objects/2026-09/contacts/batch/upsert", { inputs: [{ id: `f@${domain}`, idProperty: "email", properties: { firstname: "F" } }] });
    const results = {
      single: await companiesOf(single.body.id), additional: await companiesOf(additional.body.id),
      unknown: await companiesOf(unknown.body.id), explicit: await companiesOf(explicit.body.id),
      batch: await companiesOf(batch.body.results?.[0]?.id), upsert: await companiesOf(upsert.body.results?.[0]?.id),
    };
    const created = (await api("POST", "/crm/objects/2026-09/companies/search", {
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: unknownDomain }] }],
    })).body.total;
    const t = String(target.body.id);
    const pass = [results.single, results.additional, results.batch, results.upsert].every((ids) => ids.length === 1 && ids[0] === t)
      && results.unknown.length === 0 && created === 0
      && results.explicit.length === 1 && results.explicit[0] === String(other.body.id);
    return [pass, `single/additional/batch/upsert -> ${[results.single, results.additional, results.batch, results.upsert].map((r) => r.join("+") === t ? "ok" : r.join("+") || "none").join("/")}, unknown ${results.unknown.length} (new companies ${created}), explicit kept ${results.explicit.join("+") === String(other.body.id)}`];
  });
}

await run();
