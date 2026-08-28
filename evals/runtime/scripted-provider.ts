import type { Provider, ProviderEvent, ProviderRequest, ProviderStreamOptions } from "../../src/llm/provider.js";

export class ScriptedEvalProvider implements Provider {
  readonly name = "scripted-eval";
  readonly requests: ProviderRequest[] = [];
  readonly #scripts: readonly (readonly ProviderEvent[])[];

  constructor(scripts: readonly (readonly ProviderEvent[])[]) {
    this.#scripts = scripts;
  }

  async *stream(request: ProviderRequest, options: ProviderStreamOptions = {}): AsyncIterable<ProviderEvent> {
    options.signal?.throwIfAborted();
    const script = this.#scripts[this.requests.length];
    if (script === undefined) {
      throw new Error("评测脚本没有可供本轮使用的响应");
    }
    this.requests.push(request);
    for (const event of script) {
      options.signal?.throwIfAborted();
      yield event;
    }
  }
}
