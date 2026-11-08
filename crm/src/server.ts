import Fastify, { type FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { closeStore, initializeStore, resetStore } from "./store.js";
import { runMigration } from "./migrate/index.js";
import { registerApi } from "./api/index.js";
import { invalidateSchemaCache } from "./api/records.js";
import { AgentInputError, looksEnglish, runAgent } from "./agent/index.js";
import { greetingModel, openRouterModel } from "./agent/model.js";

const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });

// Jury pages, GET /ui-api reads, and the UI assistant are public so evaluators can use them.
// Mutations and the official CRM API (including /__agente) still require the bearer token.
const uiPages = {
  companies: "/companies",
  contacts: "/contacts",
  deals: "/deals",
  tickets: "/tickets",
  lists: "/dormant-customers",
  dormant_customers: "/dormant-customers",
};

app.get("/health", async () => ({
  status: "ok",
  version: "2026-09",
  ui: uiPages,
}));

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const assetTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};
const uiRoutes = ["/", "/login", "/companies", "/companies/:id", "/contacts", "/deals", "/tickets", "/dormant-customers"];
const publicRoutes = new Set([...uiRoutes, "/assets/*", "/favicon.svg"]);

async function sendShell(reply: FastifyReply) {
  try {
    const html = await readFile(join(publicDir, "index.html"));
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(html);
  } catch {
    return reply.code(503).type("text/plain").send("The web interface has not been built.");
  }
}
for (const route of uiRoutes) app.get(route, async (_request, reply) => sendShell(reply));
app.get("/assets/*", async (request, reply) => {
  const name = (request.params as { "*": string })["*"];
  if (!/^[\w.-]+$/.test(name)) return reply.code(404).send();
  try {
    const body = await readFile(join(publicDir, "assets", name));
    return reply.type(assetTypes[extname(name)] ?? "application/octet-stream").header("cache-control", "public, max-age=31536000, immutable").send(body);
  } catch {
    return reply.code(404).send();
  }
});
app.get("/favicon.svg", async (_request, reply) => {
  try {
    return reply.type("image/svg+xml").send(await readFile(join(publicDir, "favicon.svg")));
  } catch {
    return reply.code(404).send();
  }
});

function tokensMatch(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

app.addHook("onRequest", async (request, reply) => {
  const isHealth = request.method === "GET" && (request.routeOptions.url === "/health" || publicRoutes.has(request.routeOptions.url ?? ""));
  const isUiRead = request.method === "GET" && request.routeOptions.url?.startsWith("/ui-api/");
  const isUiAssistant = request.method === "POST" && request.routeOptions.url === "/ui-api/assistant";
  const isExportDownload = request.method === "GET"
    && /^\/exports\/[^/]+\/download(?:\?|$)/.test(request.url);
  if (isHealth || isUiRead || isUiAssistant || isExportDownload) return;

  const configuredToken = process.env.CRM_TOKEN;
  const authorization = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const suppliedToken = match?.[1];
  if (!configuredToken || !suppliedToken || !tokensMatch(suppliedToken, configuredToken)) {
    return reply.code(401).send({
      status: "error",
      message: "Authentication credentials are missing or invalid.",
      category: "INVALID_AUTHENTICATION",
      correlationId: randomUUID(),
    });
  }
});

app.addHook("onClose", async () => closeStore());

app.post("/__reset", async (_request, reply) => {
  await resetStore();
  return reply.code(204).send();
});

app.post<{ Body: { export_url?: string } }>("/__migrate", {
  schema: {
    body: {
      type: "object",
      required: ["export_url"],
      properties: { export_url: { type: "string", minLength: 1 } },
    },
  },
}, async (request, reply) => {
  try {
    await runMigration(request.body.export_url!, (message) => request.log.info(message));
  } finally {
    invalidateSchemaCache();
  }
  return reply.code(204).send();
});

const model = openRouterModel();
let agentSpend = 0;

// The assistant. x-crm-check-model: mock (scripts/check.ts) answers without calling the model.
app.post("/__agente", async (request, reply) => {
  const mock = request.headers["x-crm-check-model"] === "mock";
  try {
    const result = await runAgent(request.body, mock ? greetingModel : model, (message) => request.log.info(message));
    agentSpend += result.usage.cost ?? 0;
    request.log.info(`agente total spend since start: $${agentSpend.toFixed(4)}`);
    return { reply: result.reply };
  } catch (error) {
    if (error instanceof AgentInputError) {
      return reply.code(400).send({ status: "error", message: error.message, correlationId: randomUUID(), category: "VALIDATION_ERROR" });
    }
    request.log.error(error);
    const messages = (request.body as { messages?: Array<{ content?: unknown }> })?.messages ?? [];
    const english = looksEnglish(String(messages.at(-1)?.content ?? ""));
    return {
      reply: english
        ? "Sorry, something went wrong on my side and I have not changed anything in the CRM. Please try again."
        : "Mi dispiace, si è verificato un problema da parte mia e non ho modificato nulla nel CRM. Puoi riprovare?",
    };
  }
});

registerApi(app);

const port = Number(process.env.PORT ?? 3000);

await initializeStore();
await app.listen({ host: "0.0.0.0", port });
