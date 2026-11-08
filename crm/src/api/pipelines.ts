// Pipelines API (2026-09): pipelines and stages for deals and tickets, with /crm/v3 aliases.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { query } from "../store.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { invalidateSchemaCache, pipelinesOf, type PipelineRow, type Stage } from "./records.js";
import { typeParam } from "./objects.js";

const prefixes = ["/crm/pipelines/2026-09", "/crm/v3/pipelines"];

type StageBody = { id?: string; label?: string; displayOrder?: number; metadata?: Record<string, unknown> };
type PipelineBody = { id?: string; label?: string; displayOrder?: number; stages?: StageBody[] };

function stageOut(stage: Stage, pipeline: PipelineRow, type: string): Record<string, unknown> {
  const closed = stage.closed ?? stage.metadata?.isClosed === "true";
  const metadata: Record<string, string> = type === "tickets"
    ? { ticketState: closed ? "CLOSED" : "OPEN", isClosed: String(closed), ...(stage.metadata ?? {}) }
    : { isClosed: String(closed), probability: String(stage.probability ?? stage.metadata?.probability ?? (closed ? 0 : 0.5)), ...(stage.metadata ?? {}) };
  return {
    id: stage.id, label: stage.label, displayOrder: stage.displayOrder, metadata,
    createdAt: pipeline.created_at.toISOString(), updatedAt: pipeline.updated_at.toISOString(),
    archived: false, writePermissions: "CRUD_ALL",
  };
}

function pipelineOut(pipeline: PipelineRow, type: string): Record<string, unknown> {
  return {
    id: pipeline.pipeline_id, label: pipeline.label, displayOrder: pipeline.display_order,
    stages: [...pipeline.stages].sort((a, b) => a.displayOrder - b.displayOrder).map((s) => stageOut(s, pipeline, type)),
    createdAt: pipeline.created_at.toISOString(), updatedAt: pipeline.updated_at.toISOString(), archived: pipeline.archived,
  };
}

function stageIn(body: StageBody, index: number, type: string, existing?: Stage): Stage {
  const metadata = Object.fromEntries(Object.entries({ ...(existing?.metadata ?? {}), ...(body.metadata ?? {}) }).map(([k, v]) => [k, String(v)]));
  if (type === "deals" && metadata.probability === undefined) throw badRequest("Deal stages need metadata.probability");
  const closed = type === "tickets" ? metadata.ticketState === "CLOSED" || metadata.isClosed === "true" : metadata.isClosed === "true" || ["0.0", "1.0", "0", "1"].includes(metadata.probability ?? "") && metadata.isClosed !== "false";
  const stage: Stage = {
    id: body.id ?? existing?.id ?? `${Date.now()}${index}`,
    label: body.label ?? existing?.label ?? "",
    displayOrder: body.displayOrder ?? existing?.displayOrder ?? index,
    closed, metadata,
  };
  if (type === "deals") stage.probability = Number(metadata.probability);
  if (!stage.label) throw badRequest("Stage label is required");
  return stage;
}

async function getPipeline(type: string, id: string): Promise<PipelineRow> {
  const pipeline = (await pipelinesOf(type as never)).find((p) => p.pipeline_id === id);
  if (!pipeline) throw notFound(`Unable to find pipeline ${id}.`);
  return pipeline;
}

async function saveStages(type: string, id: string, stages: Stage[], label?: string, displayOrder?: number): Promise<void> {
  await query(
    `UPDATE pipelines SET stages = $3::jsonb, label = coalesce($4, label), display_order = coalesce($5, display_order), updated_at = NOW()
     WHERE object_type = $1 AND pipeline_id = $2`,
    [type, id, JSON.stringify(stages), label ?? null, displayOrder ?? null]);
  invalidateSchemaCache();
}

export function registerPipelineRoutes(app: FastifyInstance): void {
  for (const prefix of prefixes) {
    type P = { objectType: string; pipelineId?: string; stageId?: string };

    app.get(`${prefix}/:objectType`, async (request: FastifyRequest<{ Params: P }>) => {
      const type = typeParam(request.params.objectType);
      return { results: (await pipelinesOf(type)).map((p) => pipelineOut(p, type)) };
    });
    app.get(`${prefix}/:objectType/:pipelineId`, async (request: FastifyRequest<{ Params: P }>) => {
      const type = typeParam(request.params.objectType);
      return pipelineOut(await getPipeline(type, request.params.pipelineId!), type);
    });
    app.post(`${prefix}/:objectType`, async (request: FastifyRequest<{ Params: P; Body: PipelineBody }>, reply) => {
      const type = typeParam(request.params.objectType);
      const body = request.body ?? {};
      if (!body.label) throw badRequest("label is required");
      const stages = (body.stages ?? []).map((s, i) => stageIn(s, i, type));
      if (!stages.length) throw badRequest("A pipeline needs at least one stage");
      const id = body.id ?? String(Date.now());
      const existing = await pipelinesOf(type);
      if (existing.some((p) => p.pipeline_id === id || p.label.toLowerCase() === body.label!.toLowerCase())) {
        throw conflict(`A pipeline with label ${body.label} already exists.`);
      }
      await query(
        `INSERT INTO pipelines (object_type, pipeline_id, label, stages, display_order) VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [type, id, body.label, JSON.stringify(stages), body.displayOrder ?? existing.length]);
      invalidateSchemaCache();
      return reply.code(201).send(pipelineOut(await getPipeline(type, id), type));
    });
    const replace = async (request: FastifyRequest<{ Params: P; Body: PipelineBody }>, partial: boolean) => {
      const type = typeParam(request.params.objectType);
      const pipeline = await getPipeline(type, request.params.pipelineId!);
      const body = request.body ?? {};
      const stages = body.stages ? body.stages.map((s, i) => stageIn(s, i, type, pipeline.stages.find((x) => x.id === s.id))) : partial ? pipeline.stages : [];
      if (!stages.length) throw badRequest("A pipeline needs at least one stage");
      await saveStages(type, pipeline.pipeline_id, stages, body.label, body.displayOrder);
      return pipelineOut(await getPipeline(type, pipeline.pipeline_id), type);
    };
    app.patch(`${prefix}/:objectType/:pipelineId`, (request: FastifyRequest<{ Params: P; Body: PipelineBody }>) => replace(request, true));
    app.put(`${prefix}/:objectType/:pipelineId`, (request: FastifyRequest<{ Params: P; Body: PipelineBody }>) => replace(request, false));
    app.delete(`${prefix}/:objectType/:pipelineId`, async (request: FastifyRequest<{ Params: P }>, reply) => {
      const type = typeParam(request.params.objectType);
      const pipeline = await getPipeline(type, request.params.pipelineId!);
      await query(`DELETE FROM pipelines WHERE object_type = $1 AND pipeline_id = $2`, [type, pipeline.pipeline_id]);
      invalidateSchemaCache();
      return reply.code(204).send();
    });

    // ---- stages ----
    app.get(`${prefix}/:objectType/:pipelineId/stages`, async (request: FastifyRequest<{ Params: P }>) => {
      const type = typeParam(request.params.objectType);
      const pipeline = await getPipeline(type, request.params.pipelineId!);
      return { results: (pipelineOut(pipeline, type).stages as unknown[]) };
    });
    app.get(`${prefix}/:objectType/:pipelineId/stages/:stageId`, async (request: FastifyRequest<{ Params: P }>) => {
      const type = typeParam(request.params.objectType);
      const pipeline = await getPipeline(type, request.params.pipelineId!);
      const stage = pipeline.stages.find((s) => s.id === request.params.stageId);
      if (!stage) throw notFound(`Unable to find stage ${request.params.stageId}.`);
      return stageOut(stage, pipeline, type);
    });
    app.post(`${prefix}/:objectType/:pipelineId/stages`, async (request: FastifyRequest<{ Params: P; Body: StageBody }>, reply) => {
      const type = typeParam(request.params.objectType);
      const pipeline = await getPipeline(type, request.params.pipelineId!);
      const stage = stageIn(request.body ?? {}, pipeline.stages.length, type);
      if (pipeline.stages.some((s) => s.id === stage.id)) throw conflict(`Stage ${stage.id} already exists.`);
      await saveStages(type, pipeline.pipeline_id, [...pipeline.stages, stage]);
      return reply.code(201).send(stageOut(stage, await getPipeline(type, pipeline.pipeline_id), type));
    });
    const updateStage = async (request: FastifyRequest<{ Params: P; Body: StageBody }>) => {
      const type = typeParam(request.params.objectType);
      const pipeline = await getPipeline(type, request.params.pipelineId!);
      const index = pipeline.stages.findIndex((s) => s.id === request.params.stageId);
      if (index < 0) throw notFound(`Unable to find stage ${request.params.stageId}.`);
      const stage = stageIn({ ...request.body, id: request.params.stageId }, index, type, pipeline.stages[index]);
      const stages = [...pipeline.stages];
      stages[index] = stage;
      await saveStages(type, pipeline.pipeline_id, stages);
      return stageOut(stage, await getPipeline(type, pipeline.pipeline_id), type);
    };
    app.patch(`${prefix}/:objectType/:pipelineId/stages/:stageId`, updateStage);
    app.put(`${prefix}/:objectType/:pipelineId/stages/:stageId`, updateStage);
    app.delete(`${prefix}/:objectType/:pipelineId/stages/:stageId`, async (request: FastifyRequest<{ Params: P }>, reply) => {
      const type = typeParam(request.params.objectType);
      const pipeline = await getPipeline(type, request.params.pipelineId!);
      if (!pipeline.stages.some((s) => s.id === request.params.stageId)) throw notFound(`Unable to find stage ${request.params.stageId}.`);
      await saveStages(type, pipeline.pipeline_id, pipeline.stages.filter((s) => s.id !== request.params.stageId));
      return reply.code(204).send();
    });
  }
}
