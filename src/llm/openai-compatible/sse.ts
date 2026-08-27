import { OpenAICompatibleProtocolError } from "./protocol-error.js";

interface LineState {
  readonly payloads: string[];
  readonly dataLines: string[];
}

function consumeLine(line: string, state: LineState): void {
  if (line.length === 0) {
    if (state.dataLines.length > 0) {
      state.payloads.push(state.dataLines.join("\n"));
      state.dataLines.length = 0;
    }
    return;
  }
  if (line.startsWith(":")) {
    return;
  }

  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }
  if (field === "data") {
    state.dataLines.push(value);
  }
}

function consumeAvailableLines(buffer: string, state: LineState): string {
  let start = 0;
  while (true) {
    const newline = buffer.indexOf("\n", start);
    if (newline === -1) {
      return buffer.slice(start);
    }
    const lineEnd = newline > start && buffer[newline - 1] === "\r" ? newline - 1 : newline;
    consumeLine(buffer.slice(start, lineEnd), state);
    start = newline + 1;
  }
}

export async function* parseSseData(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: LineState = { payloads: [], dataLines: [] };
  let buffer = "";
  let exhausted = false;

  const cancelReader = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReader, { once: true });

  try {
    signal?.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) {
        exhausted = true;
        try {
          buffer += decoder.decode();
        } catch {
          throw new OpenAICompatibleProtocolError();
        }
        break;
      }

      try {
        buffer += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new OpenAICompatibleProtocolError();
      }
      buffer = consumeAvailableLines(buffer, state);
      while (state.payloads.length > 0) {
        const payload = state.payloads.shift();
        if (payload !== undefined) {
          yield payload;
        }
      }
    }

    if (buffer.length > 0) {
      consumeLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer, state);
    }
    if (state.dataLines.length > 0) {
      state.payloads.push(state.dataLines.join("\n"));
      state.dataLines.length = 0;
    }
    for (const payload of state.payloads) {
      yield payload;
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    if (!exhausted) {
      try {
        await reader.cancel(signal?.reason);
      } catch {
        // 保留原始协议、网络或取消结果，不让清理失败覆盖它。
      }
    }
    reader.releaseLock();
  }
}
