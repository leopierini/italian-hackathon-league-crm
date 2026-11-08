import type { FastifyError, FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import { registerAssociationRoutes } from "./associations.js";
import { registerObjectRoutes } from "./objects.js";
import { registerExportRoutes } from "./exports.js";
import { registerListRoutes } from "./lists.js";
import { registerPipelineRoutes } from "./pipelines.js";
import { registerPropertyRoutes } from "./properties.js";
import { registerUiRoutes } from "./ui.js";
import { onReset } from "../store.js";

const WINDOW_MS = 10_000;
const WINDOW_MAX = 100;
const DAILY_MAX = 250_000;
let counters = { windowStart: 0, inWindow: 0, day: "", today: 0 };
onReset(() => { counters = { windowStart: 0, inWindow: 0, day: "", today: 0 }; });

function countRequest(): { windowRemaining: number; dailyRemaining: number } {
  const now = Date.now();
  if (now - counters.windowStart >= WINDOW_MS) counters = { ...counters, windowStart: now, inWindow: 0 };
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== counters.day) counters = { ...counters, day, today: 0 };
  counters.inWindow += 1;
  counters.today += 1;
  return { windowRemaining: Math.max(WINDOW_MAX - counters.inWindow, 0), dailyRemaining: Math.max(DAILY_MAX - counters.today, 0) };
}

export function registerApi(app: FastifyInstance): void {
  // JSON bodies may be empty (DELETE/POST with a content-type header and no body).
  // text/plain bodies are read as JSON too (some clients mislabel them); anything else is 415.
  app.removeContentTypeParser(["application/json", "text/plain"]);
  app.addContentTypeParser(["application/json", "text/plain"], { parseAs: "string" }, (_request, body, done) => {
    const text = String(body ?? "").trim();
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError(400, "VALIDATION_ERROR", "Invalid input JSON on line 1: the request body is not valid JSON."), undefined);
    }
  });

  // Rate-limit headers as HubSpot sends them (100 per 10 s, 250,000 per day for a private app).
  // Counted in memory and zeroed by /__reset; never enforced with 429, so test load is not throttled.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/crm/") || path.endsWith("/search")) return;
    const { windowRemaining, dailyRemaining } = countRequest();
    reply.header("X-HubSpot-RateLimit-Daily", String(DAILY_MAX));
    reply.header("X-HubSpot-RateLimit-Daily-Remaining", String(dailyRemaining));
    reply.header("X-HubSpot-RateLimit-Interval-Milliseconds", String(WINDOW_MS));
    reply.header("X-HubSpot-RateLimit-Max", String(WINDOW_MAX));
    reply.header("X-HubSpot-RateLimit-Remaining", String(windowRemaining));
  });

  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send(error.body());
    const status = (error as FastifyError).statusCode ?? 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({
      status: "error",
      message: status >= 500 ? "Internal error" : error.message,
      correlationId: randomUUID(),
      category: status === 400 ? "VALIDATION_ERROR" : status === 404 ? "OBJECT_NOT_FOUND" : status === 401 ? "INVALID_AUTHENTICATION" : status === 415 ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
    });
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    status: "error",
    message: `Resource not found: ${request.method} ${request.url.split("?")[0]}`,
    correlationId: randomUUID(),
    category: "OBJECT_NOT_FOUND",
  }));

  registerObjectRoutes(app);
  registerAssociationRoutes(app);
  registerPropertyRoutes(app);
  registerPipelineRoutes(app);
  registerListRoutes(app);
  registerExportRoutes(app);
  registerUiRoutes(app);
}
