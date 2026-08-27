import type { FetchTransport } from "../../src/llm/openai-compatible/provider.js";
import type { ProviderEvent, ProviderRequest } from "../../src/llm/provider.js";

const encoder = new TextEncoder();

export const basicRequest: ProviderRequest = {
  model: "fixture-model",
  messages: [{ role: "user", content: "请检查代码" }],
  tools: [],
};

export function encode(value: string): Uint8Array {
  return encoder.encode(value);
}

export function sseData(payload: unknown, lineEnding = "\n"): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}${lineEnding}${lineEnding}`;
}

export function completionChunk(
  delta: Readonly<Record<string, unknown>>,
  finishReason: "stop" | "tool_calls" | "length" | string | null = null,
  index = 0,
): Readonly<Record<string, unknown>> {
  return {
    id: "fixture-completion",
    object: "chat.completion.chunk",
    choices: [{ index, delta, finish_reason: finishReason }],
  };
}

export function responseFromChunks(chunks: readonly Uint8Array[], init: ResponseInit = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/event-stream; charset=utf-8");
  }
  return new Response(stream, { ...init, headers });
}

export function successfulTextResponse(text = "完成"): Response {
  return responseFromChunks([
    encode(
      `${sseData(completionChunk({ role: "assistant", content: text }))}${sseData(
        completionChunk({}, "stop"),
      )}${sseData({ choices: [], usage: { total_tokens: 3 } })}${sseData("[DONE]")}`,
    ),
  ]);
}

export interface FetchRecorder {
  readonly calls: Array<{ readonly input: string | URL | Request; readonly init?: RequestInit }>;
  readonly fetch: FetchTransport;
}

export function recordFetch(response: Response | (() => Response | Promise<Response>)): FetchRecorder {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return typeof response === "function" ? response() : response;
    },
  };
}

export async function collectProviderEvents(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
