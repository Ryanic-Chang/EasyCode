import { ApplyPatchTool } from "./apply-patch.js";
import { ListDirectoryTool } from "./list-directory.js";
import { ReadFileTool } from "./read-file.js";
import { ToolRegistry } from "./registry.js";
import { RunCommandTool } from "./run-command.js";
import { SearchFilesTool } from "./search-files.js";

export function createCodingToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ListDirectoryTool());
  registry.register(new SearchFilesTool());
  registry.register(new ReadFileTool());
  registry.register(new ApplyPatchTool());
  registry.register(new RunCommandTool());
  return registry;
}
