import type { Provider, ProviderEvent, ProviderRequest, ProviderStreamOptions } from "../src/llm/provider.js";

export type FakeProviderAction = (options: ProviderStreamOptions) => void | Promise<void>;
export type FakeProviderStep = ProviderEvent | FakeProviderAction;

export class FakeProvider implements Provider {
  readonly name = "fake";
  readonly requests: ProviderRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly #scripts: FakeProviderStep[][];

  constructor(scripts: readonly (readonly FakeProviderStep[])[]) {
    this.#scripts = scripts.map((script) => [...script]);
  }

  async *stream(request: ProviderRequest, options: ProviderStreamOptions = {}): AsyncIterable<ProviderEvent> {
    options.signal?.throwIfAborted();

    const script = this.#scripts.shift();
    if (script === undefined) {
      throw new Error("FakeProvider 没有可供本次请求使用的脚本");
    }

    this.requests.push(request);
    this.signals.push(options.signal);

    for (const step of script) {
      options.signal?.throwIfAborted();
      if (typeof step === "function") {
        await step(options);
      } else {
        yield step;
      }
    }
  }
}
