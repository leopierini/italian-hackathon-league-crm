// Durability checks against a running, migrated CRM (local or Railway):
// concurrent PATCH, parallel upserts and creates on one email, paging of every contact, and
// single-record read latency with 20 parallel clients. Run: npx tsx scripts/durability.ts
// (CRM_URL, CRM_TOKEN; LOAD_SECONDS default 15; SKIP_PAGING=1 to skip the full paging pass).
import { performance } from "node:perf_hooks";

const crmUrl = process.env.CRM_URL?.replace(/\/$/, "");
const token = process.env.CRM_TOKEN;
if (!crmUrl || !token) throw new Error("CRM_URL and CRM_TOKEN are required");
let failures = 0;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${crmUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

async function check(name: string, fn: () => Promise<[boolean, string]>): Promise<void> {
  const started = performance.now();
  try {
    const [pass, value] = await fn();
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${value} (${Math.round(performance.now() - started)} ms)`);
    if (!pass) failures += 1;
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
    failures += 1;
  }
}

const stamp = Date.now();
const C = "/crm/objects/2026-09/contacts";

await check("20 parallel PATCH, different properties", async () => {
  const created = await api("POST", C, { properties: { email: `dur-patch-${stamp}@example.invalid` } });
  const id = created.body.id;
  const props = ["firstname", "lastname", "phone", "mobilephone", "city", "state", "zip", "address", "country", "jobtitle",
    "company", "website", "fax", "industry", "annualrevenue", "numemployees", "message", "hs_lead_status", "lifecyclestage", "salutation"];
  const values: Record<string, string> = {};
  for (const [i, p] of props.entries()) {
    values[p] = p === "annualrevenue" || p === "numemployees" ? String(1000 + i) : p === "hs_lead_status" ? "OPEN" : p === "lifecyclestage" ? "lead" : `v${i}-${stamp}`;
  }
  const responses = await Promise.all(props.map((p) => api("PATCH", `${C}/${id}`, { properties: { [p]: values[p] } })));
  const bad = responses.filter((r) => r.status !== 200);
  const got = await api("GET", `${C}/${id}?properties=${props.join(",")}`);
  const lost = props.filter((p) => got.body.properties?.[p] !== values[p]);
  return [bad.length === 0 && lost.length === 0, `${responses.length - bad.length}/20 x 200${bad.length ? ` (bad: ${bad.map((r) => r.status).join(",")} ${JSON.stringify(bad[0]?.body).slice(0, 200)})` : ""}, values lost: ${lost.length ? lost.join(",") : "none"}`];
});

await check("10 parallel batch upserts, same new email", async () => {
  const email = `dur-upsert-${stamp}@example.invalid`;
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    api("POST", `${C}/batch/upsert`, { inputs: [{ id: email, idProperty: "email", properties: { firstname: `U${i}` } }] })));
  await new Promise((r) => setTimeout(r, 500));
  const found = await api("POST", `${C}/search`, { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] });
  const ok = responses.filter((r) => r.status === 200).length;
  const ids = new Set(responses.map((r) => r.body.results?.[0]?.id));
  return [ok === 10 && found.body.total === 1 && ids.size === 1, `${ok}/10 x 200, distinct ids ${ids.size}, contacts with that email ${found.body.total}`];
});

await check("10 parallel creates, same new email", async () => {
  const email = `dur-create-${stamp}@example.invalid`;
  const responses = await Promise.all(Array.from({ length: 10 }, () => api("POST", C, { properties: { email } })));
  const created = responses.filter((r) => r.status === 201).length;
  const conflicts = responses.filter((r) => r.status === 409).length;
  const found = await api("POST", `${C}/search`, { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] });
  return [created === 1 && conflicts === 9 && found.body.total === 1, `${created}x201 ${conflicts}x409, contacts with that email ${found.body.total}`];
});

await check("20 parallel creates, different emails", async () => {
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => api("POST", C, { properties: { email: `dur-many-${i}-${stamp}@example.invalid` } })));
  const found = await api("POST", `${C}/search`, { filterGroups: [{ filters: [{ propertyName: "email", operator: "CONTAINS_TOKEN", value: `*-${stamp}@example.invalid` }, { propertyName: "email", operator: "CONTAINS_TOKEN", value: "dur-many-*" }] }] });
  return [responses.every((r) => r.status === 201) && found.body.total === 20, `${responses.filter((r) => r.status === 201).length}/20 x 201, found ${found.body.total}`];
});

if (process.env.SKIP_PAGING !== "1") {
  await check("list paging: every contact exactly once", async () => {
    const total = (await api("POST", `${C}/search`, { limit: 1 })).body.total;
    const seen = new Set<string>();
    let after = "";
    let calls = 0;
    let slowest = 0;
    do {
      const started = performance.now();
      const page = await api("GET", `${C}?limit=100${after ? `&after=${after}` : ""}`);
      slowest = Math.max(slowest, performance.now() - started);
      for (const r of page.body.results ?? []) seen.add(r.id);
      after = page.body.paging?.next?.after ?? "";
      calls += 1;
    } while (after && calls < 5000);
    return [seen.size === total && calls === Math.ceil(total / 100), `${seen.size} distinct of total ${total} in ${calls} calls, slowest ${Math.round(slowest)} ms`];
  });
}

await check("read latency, 20 parallel clients", async () => {
  const sample = (await api("GET", `${C}?limit=100`)).body.results.map((r: Json) => r.id) as string[];
  const seconds = Number(process.env.LOAD_SECONDS ?? 15);
  const deadline = Date.now() + seconds * 1000;
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  await Promise.all(Array.from({ length: 20 }, async (_, worker) => {
    let i = worker;
    while (Date.now() < deadline) {
      const id = sample[i++ % sample.length];
      const started = performance.now();
      let status = 0;
      try {
        const response = await fetch(`${crmUrl}${C}/${id}?properties=email,firstname,lastname`, {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
        });
        await response.arrayBuffer();
        status = response.status;
      } catch {
        status = -1;
      }
      latencies.push(performance.now() - started);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
  }));
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!);
  const non2xx = [...statuses.entries()].filter(([s]) => s < 200 || s >= 300).reduce((n, [, c]) => n + c, 0);
  const under1s = latencies.filter((l) => l < 1000).length / latencies.length;
  return [non2xx === 0 && under1s >= 0.95, `${latencies.length} reads in ${seconds} s, p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, p99 ${pct(0.99)} ms, under 1 s ${(under1s * 100).toFixed(1)}%, non-2xx ${non2xx}`];
});

process.exitCode = failures ? 1 : 0;
