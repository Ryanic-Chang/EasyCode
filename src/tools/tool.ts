export type ToolInputSchema = Readonly<Record<string, unknown>>;

export interface ToolContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface ToolExecutionResult {
  readonly output: string;
  readonly isError: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Tool<Input = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;

  parse(input: unknown): Input;
  execute(input: Input, context: ToolContext): Promise<ToolExecutionResult>;
}
