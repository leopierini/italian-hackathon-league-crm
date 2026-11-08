// Chat model client: OpenRouter, model openai/gpt-6-luna only (the key works only with it).
// Messages and tools in the OpenAI chat-completions format.

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number };
export type Completion = { message: Extract<ChatMessage, { role: "assistant" }>; usage?: Usage };
export type ModelRequest = { messages: ChatMessage[]; tools: ToolDef[]; toolChoice: "auto" | "none" };
export type ModelFn = (request: ModelRequest, signal: AbortSignal) => Promise<Completion>;

export const MODEL_ID = "openai/gpt-6-luna";

export class ModelError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export function openRouterModel(): ModelFn {
  return async ({ messages, tools, toolChoice }, signal) => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new ModelError("OPENROUTER_API_KEY is not set", false);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Brambilla CRM" },
      body: JSON.stringify({
        model: MODEL_ID,
        messages,
        tools,
        tool_choice: toolChoice,
        reasoning: { effort: process.env.AGENTE_REASONING || "low" },
        max_tokens: 8000,
        usage: { include: true },
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ModelError(`model HTTP ${response.status}: ${text.slice(0, 300)}`, response.status === 429 || response.status >= 500);
    }
    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
      usage?: Usage; error?: { message?: string };
    };
    const message = json.choices?.[0]?.message;
    if (!message) throw new ModelError(`model returned no message: ${json.error?.message ?? text.slice(0, 200)}`, true);
    return {
      message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) },
      usage: json.usage,
    };
  };
}

// Used by scripts/check.ts (header x-crm-check-model: mock): no model call, a fixed greeting.
export const greetingModel: ModelFn = async () => ({
  message: { role: "assistant", content: "Ciao! Sono l'assistente del CRM di Brambilla Forniture: dimmi pure cosa ti serve." },
});
