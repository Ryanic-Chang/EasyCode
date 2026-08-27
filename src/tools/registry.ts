import type { Tool, ToolContext, ToolExecutionResult, ToolInputSchema } from "./tool.js";

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

export interface PreparedTool {
  readonly descriptor: ToolDescriptor;
  execute(context: ToolContext): Promise<ToolExecutionResult>;
}

interface RegisteredTool {
  readonly descriptor: ToolDescriptor;
  prepare(input: unknown): PreparedTool;
}

function wrapTool<Input>(tool: Tool<Input>): RegisteredTool {
  const descriptor: ToolDescriptor = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };

  return {
    descriptor,
    prepare(input: unknown): PreparedTool {
      const parsedInput = tool.parse(input);

      return {
        descriptor,
        execute(context: ToolContext): Promise<ToolExecutionResult> {
          return tool.execute(parsedInput, context);
        },
      };
    },
  };
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register<Input>(tool: Tool<Input>): void {
    if (tool.name.length === 0 || tool.name.trim() !== tool.name) {
      throw new Error("工具名称必须是非空且不含首尾空白的字符串");
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`工具名称重复：${tool.name}`);
    }

    this.#tools.set(tool.name, wrapTool(tool));
  }

  list(): readonly ToolDescriptor[] {
    return [...this.#tools.values()].map(({ descriptor }) => descriptor);
  }

  prepare(name: string, input: unknown): PreparedTool | undefined {
    return this.#tools.get(name)?.prepare(input);
  }
}
