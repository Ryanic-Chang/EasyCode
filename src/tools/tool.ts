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

export interface ApprovalRequirement {
  readonly riskCategory: string;
  readonly actionSummary: string;
}

export interface Tool<Input = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;

  parse(input: unknown): Input;
  approval?(input: Input): ApprovalRequirement | undefined;
  execute(input: Input, context: ToolContext): Promise<ToolExecutionResult>;
}
