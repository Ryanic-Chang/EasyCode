import type { Provider, ProviderEvent, ProviderRequest, ProviderStreamOptions } from "../src/llm/provider.js";

export class FakeProvider implements Provider {
  readonly name = "fake";
  readonly requests: ProviderRequest[] = [];
  readonly #scripts: ProviderEvent[][];

  constructor(scripts: readonly (readonly ProviderEvent[])[]) {
    this.#scripts = scripts.map((script) => [...script]);
  }

  async *stream(request: ProviderRequest, options: ProviderStreamOptions = {}): AsyncIterable<ProviderEvent> {
    options.signal?.throwIfAborted();

    const script = this.#scripts.shift();
    if (script === undefined) {
      throw new Error("FakeProvider 没有可供本次请求使用的脚本");
    }

    this.requests.push(request);

    for (const event of script) {
      options.signal?.throwIfAborted();
      yield event;
    }
  }
}
