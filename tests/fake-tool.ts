import type { Tool, ToolContext, ToolExecutionResult, ToolInputSchema } from "../src/tools/tool.js";

export interface FakeToolOptions<Input> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: ToolInputSchema;
  parse(input: unknown): Input;
  execute(input: Input, context: ToolContext): ToolExecutionResult | Promise<ToolExecutionResult>;
}

export interface FakeToolExecution<Input> {
  readonly input: Input;
  readonly context: ToolContext;
}

export class FakeTool<Input> implements Tool<Input> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly parseInputs: unknown[] = [];
  readonly executions: FakeToolExecution<Input>[] = [];
  readonly #options: FakeToolOptions<Input>;

  constructor(options: FakeToolOptions<Input>) {
    this.#options = options;
    this.name = options.name;
    this.description = options.description ?? `测试工具：${options.name}`;
    this.inputSchema = options.inputSchema ?? { type: "object" };
  }

  parse(input: unknown): Input {
    this.parseInputs.push(input);
    return this.#options.parse(input);
  }

  execute(input: Input, context: ToolContext): Promise<ToolExecutionResult> {
    this.executions.push({ input, context });
    return Promise.resolve(this.#options.execute(input, context));
  }
}
