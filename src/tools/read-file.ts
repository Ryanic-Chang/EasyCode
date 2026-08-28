import { domainFailure, ToolDomainError, ToolInputError } from "./errors.js";
import { MAX_TOOL_OUTPUT_BYTES, readUtf8File, truncateUtf8 } from "./text.js";
import type { Tool, ToolContext, ToolExecutionResult } from "./tool.js";
import { optionalPositiveInteger, rejectUnknownKeys, requireRecord, requireString } from "./validation.js";
import { normalizeWorkspacePath, WorkspaceBoundary } from "./workspace.js";

export interface ReadFileInput {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export class ReadFileTool implements Tool<ReadFileInput> {
  readonly name = "read_file";
  readonly description = "读取 workspace 内有大小上限的 UTF-8 普通文件，可指定 1-based inclusive 行范围。";
  readonly inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "workspace 相对文件路径" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
  } as const;

  parse(input: unknown): ReadFileInput {
    const record = requireRecord(input);
    rejectUnknownKeys(record, ["path", "startLine", "endLine"]);
    const startLine = optionalPositiveInteger(record, "startLine");
    const endLine = optionalPositiveInteger(record, "endLine");
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      throw new ToolInputError("endLine 不能小于 startLine");
    }
    return {
      path: normalizeWorkspacePath(requireString(record, "path", 1024), false),
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
    };
  }

  async execute(input: ReadFileInput, context: ToolContext): Promise<ToolExecutionResult> {
    context.signal.throwIfAborted();
    try {
      const workspace = await WorkspaceBoundary.create(context.cwd);
      const target = await workspace.resolveExisting(input.path, "file");
      const file = await readUtf8File(target.canonicalPath, context.signal);
      const lines = file.text.split(/\r\n|\n|\r/);
      const startLine = input.startLine ?? 1;
      const endLine = input.endLine ?? lines.length;
      if (startLine > lines.length || endLine > lines.length) {
        throw new ToolDomainError("range_out_of_bounds", `请求行范围超出文件的 ${lines.length} 行。`);
      }

      const numbered = lines
        .slice(startLine - 1, endLine)
        .map((line, index) => `${startLine + index}: ${line}`)
        .join("\n");
      const output = truncateUtf8(numbered, MAX_TOOL_OUTPUT_BYTES);
      return {
        output: output.value,
        isError: false,
        metadata: {
          path: input.path,
          startLine,
          endLine,
          totalLines: lines.length,
          bytes: file.bytes,
          truncated: output.truncated,
        },
      };
    } catch (error) {
      if (error instanceof ToolDomainError) {
        return domainFailure(error);
      }
      throw error;
    }
  }
}
