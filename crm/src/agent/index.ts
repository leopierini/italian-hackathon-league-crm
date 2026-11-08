// POST /__agente: the assistant. Stateless: every turn carries the whole conversation. A tool loop
// on the model with a hard deadline, so a reply always leaves before the 60 s turn limit.
import { ModelError, type ChatMessage, type ModelFn, type Usage } from "./model.js";
import { contextMessage, systemPrompt } from "./prompt.js";
import { runTool, toolDefs, writeTools, type AgentContext } from "./tools.js";
import { looksEnglish } from "./language.js";

export { looksEnglish };

export type AgentAttachment = { name?: string; content_type?: string; content?: string };
export type AgentMessage = { role?: string; content?: unknown; attachments?: AgentAttachment[] };
export type AgentRequest = { context?: { now?: string; user?: string }; messages?: AgentMessage[] };
export type AgentResult = { reply: string; steps: number; tools: string[]; actions: string[]; usage: Usage; timedOut: boolean };

const DEADLINE_MS = Number(process.env.AGENTE_DEADLINE_MS || 50_000);
const MAX_STEPS = 14;
const TOOL_RESULT_MAX = 16_000;
const ATTACHMENT_MAX = 60_000;

export class AgentInputError extends Error {}

function toChat(messages: AgentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    let text = typeof message.content === "string" ? message.content : message.content == null ? "" : JSON.stringify(message.content);
    for (const attachment of message.attachments ?? []) {
      const content = String(attachment?.content ?? "");
      const clipped = content.length > ATTACHMENT_MAX ? `${content.slice(0, ATTACHMENT_MAX)}\n[... attachment truncated: ${content.length} characters in total]` : content;
      text += `\n\n[Attachment "${attachment?.name ?? "allegato.csv"}" (${attachment?.content_type ?? "text/csv"}), ${content.split(/\r?\n/).filter(Boolean).length} lines]\n${clipped}`;
    }
    if (message.role === "assistant") out.push({ role: "assistant", content: text });
    else out.push({ role: "user", content: text });
  }
  return out;
}

export function parseRequest(body: unknown): { now: Date; user: string; messages: AgentMessage[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AgentInputError("The body must be a JSON object with context and messages.");
  const request = body as AgentRequest;
  const messages = request.messages;
  if (!Array.isArray(messages) || !messages.length) throw new AgentInputError("messages must be a non-empty array.");
  if (messages.some((m) => !m || typeof m !== "object")) throw new AgentInputError("Each message must be an object with role and content.");
  const parsed = Date.parse(String(request.context?.now ?? ""));
  return {
    now: Number.isFinite(parsed) ? new Date(parsed) : new Date(),
    user: String(request.context?.user ?? "").trim().toLowerCase(),
    messages,
  };
}

function fallbackReply(ctx: AgentContext, english: boolean, reason: "time" | "error"): string {
  if (ctx.actions.length) {
    return english
      ? `I could not finish writing the full answer, but these changes are done in the CRM: ${ctx.actions.join("; ")}.`
      : `Non sono riuscito a completare la risposta, ma nel CRM ho già fatto queste modifiche: ${ctx.actions.join("; ")}.`;
  }
  if (reason === "time") {
    return english
      ? "Sorry, I could not complete the request in time and I have not changed anything in the CRM. Could you try again, maybe with more details?"
      : "Mi dispiace, non sono riuscito a completare la richiesta in tempo e non ho modificato nulla nel CRM. Puoi riprovare, magari con qualche dettaglio in più?";
  }
  return english
    ? "Sorry, the assistant is not available right now and I have not changed anything in the CRM. Please try again in a moment."
    : "Mi dispiace, in questo momento l'assistente non è disponibile e non ho modificato nulla nel CRM. Riprova tra poco.";
}

export async function runAgent(
  body: unknown, model: ModelFn, log: (msg: string) => void = () => {}, opts: { deadlineMs?: number } = {},
): Promise<AgentResult> {
  const started = Date.now();
  const deadline = started + (opts.deadlineMs ?? DEADLINE_MS);
  const { now, user, messages } = parseRequest(body);
  const ctx: AgentContext = { now, user, actions: [] };
  const lastUser = [...messages].reverse().find((m) => m.role !== "assistant");
  const english = looksEnglish(String(lastUser?.content ?? ""));
  const chat: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "system", content: await contextMessage(now, user, String(lastUser?.content ?? "")) },
    ...toChat(messages),
  ];
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
  const tools: string[] = [];
  let reply = "";
  let timedOut = false;
  let failed = false;
  let steps = 0;

  for (; steps < MAX_STEPS; steps++) {
    const remaining = deadline - Date.now();
    if (remaining < 2_500) { timedOut = true; break; }
    // Near the end (time or steps), the model must answer with what it has.
    const finalStep = steps === MAX_STEPS - 1 || remaining < 12_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining - 1_500);
    let completion;
    try {
      completion = await model({ messages: chat, tools: toolDefs, toolChoice: finalStep ? "none" : "auto" }, controller.signal);
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) { timedOut = true; break; }
      const retryable = error instanceof ModelError ? error.retryable : true;
      log(`agente model error (step ${steps}): ${(error as Error).message}`);
      if (retryable && deadline - Date.now() > 8_000) { await new Promise((r) => setTimeout(r, 600)); continue; }
      failed = true;
      break;
    }
    clearTimeout(timer);
    usage.prompt_tokens! += completion.usage?.prompt_tokens ?? 0;
    usage.completion_tokens! += completion.usage?.completion_tokens ?? 0;
    usage.cost! += completion.usage?.cost ?? 0;
    const message = completion.message;
    const calls = finalStep ? [] : message.tool_calls ?? [];
    if (!calls.length) {
      reply = (message.content ?? "").trim();
      break;
    }
    chat.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    // Reads run in parallel; as soon as a call writes, calls run in order.
    const sequential = calls.some((c) => writeTools.has(c.function.name));
    const execute = async (call: (typeof calls)[number]) => {
      tools.push(call.function.name);
      const result = await runTool(call.function.name, call.function.arguments, ctx);
      let text = JSON.stringify(result);
      if (text.length > TOOL_RESULT_MAX) text = `${text.slice(0, TOOL_RESULT_MAX)}... [truncated: narrow the search or ask for fewer records]`;
      return { role: "tool" as const, tool_call_id: call.id, content: text };
    };
    const results = sequential ? [] as ChatMessage[] : await Promise.all(calls.map(execute));
    if (sequential) for (const call of calls) results.push(await execute(call));
    chat.push(...results);
  }

  if (!reply) reply = fallbackReply(ctx, english, failed ? "error" : "time");
  log(`agente done in ${Date.now() - started} ms, steps ${steps + 1}, tools [${tools.join(", ")}], tokens ${usage.prompt_tokens}/${usage.completion_tokens}, cost $${(usage.cost ?? 0).toFixed(5)}${timedOut ? ", TIMED OUT" : ""}`);
  return { reply, steps: steps + 1, tools, actions: ctx.actions, usage, timedOut };
}
