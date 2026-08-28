import type { AgentTerminationReason } from "../agent/events.js";
import type { ToolCall, ToolResult } from "../agent/messages.js";
import { splitGraphemes } from "./input.js";

const MAX_FIELD_CHARACTERS = 160;
const MAX_RESULT_CHARACTERS = 320;
const SECRET_PATTERN = /\b(?:bearer\s+)?sk-[a-z0-9_.-]{8,}\b/gi;
const AUTH_PATTERN =
  /\b(authorization|api[_-]?key|access[_-]?token|password|passwd|private[_-]?key|secret|token)\b\s*[:=]\s*\S+/gi;

function cleanText(value: string): string {
  return [...value.replace(SECRET_PATTERN, "[已隐藏]").replace(AUTH_PATTERN, "$1=[已隐藏]")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function summarizeText(value: string, maximum = MAX_RESULT_CHARACTERS): string {
  const cleaned = cleanText(value);
  const graphemes = splitGraphemes(cleaned);
  if (graphemes.length <= maximum) {
    return cleaned;
  }
  const marker = "…[已省略]…";
  const markerLength = splitGraphemes(marker).length;
  const available = Math.max(2, maximum - markerLength);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${graphemes.slice(0, headLength).join("")}${marker}${graphemes.slice(-tailLength).join("")}`;
}

function stringArgument(call: ToolCall, key: string, fallback = "."): string {
  const value = call.arguments[key];
  return typeof value === "string" ? summarizeText(value, MAX_FIELD_CHARACTERS) : fallback;
}

function numberArgument(call: ToolCall, key: string): number | undefined {
  const value = call.arguments[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function summarizeToolCall(call: ToolCall): string {
  switch (call.name) {
    case "list_directory":
      return `${stringArgument(call, "path")} · depth ${numberArgument(call, "depth") ?? 1}`;
    case "search_files":
      return `“${stringArgument(call, "query", "")}” · ${stringArgument(call, "path")}`;
    case "read_file": {
      const start = numberArgument(call, "startLine");
      const end = numberArgument(call, "endLine");
      const range = start === undefined && end === undefined ? "全部" : `${start ?? 1}–${end ?? "末尾"} 行`;
      return `${stringArgument(call, "path", "未知路径")} · ${range}`;
    }
    case "apply_patch":
      return `${stringArgument(call, "operation", "未知操作")} · ${stringArgument(call, "path", "未知路径")}`;
    case "run_command": {
      const executable = stringArgument(call, "executable", "未知命令");
      const args = Array.isArray(call.arguments.args)
        ? call.arguments.args
            .filter((item): item is string => typeof item === "string")
            .slice(0, 6)
            .map((item) => summarizeText(item, 40))
            .join(" ")
        : "";
      return `${executable}${args.length > 0 ? ` ${args}` : ""} · ${stringArgument(call, "cwd")}`;
    }
    default:
      return "参数已隐藏";
  }
}

function metadataNumber(result: ToolResult, key: string): number | undefined {
  const value = result.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataBoolean(result: ToolResult, key: string): boolean {
  return result.metadata?.[key] === true;
}

export function summarizeToolResult(result: ToolResult): string {
  if (result.isError) {
    const stderr = result.metadata?.stderr;
    return summarizeText(typeof stderr === "string" && stderr.trim().length > 0 ? stderr : result.output);
  }

  switch (result.toolName) {
    case "list_directory":
      return `列出 ${metadataNumber(result, "entries") ?? 0} 项${metadataBoolean(result, "truncated") ? "，结果已截断" : ""}`;
    case "search_files":
      return `找到 ${metadataNumber(result, "matches") ?? 0} 处匹配${metadataBoolean(result, "truncated") ? "，结果已截断" : ""}`;
    case "read_file":
      return `读取 ${metadataNumber(result, "startLine") ?? 1}–${metadataNumber(result, "endLine") ?? 1} 行${metadataBoolean(result, "truncated") ? "，内容已截断" : ""}`;
    case "apply_patch":
      return summarizeText(result.output);
    case "run_command": {
      const exitCode = result.metadata?.exitCode;
      return `命令完成，exit ${typeof exitCode === "number" ? exitCode : "unknown"}${metadataBoolean(result, "truncated") ? "，输出已截断" : ""}`;
    }
    default:
      return summarizeText(result.output);
  }
}

export function terminationReasonText(reason: AgentTerminationReason): string {
  switch (reason) {
    case "complete":
      return "任务完成";
    case "aborted":
      return "任务已取消";
    case "provider_error":
      return "模型服务错误";
    case "protocol_error":
      return "模型协议错误";
    case "internal_error":
      return "内部执行错误";
    case "max_steps":
      return "达到最大轮次";
  }
}

export function safeDisplayLabel(value: string, fallback: string): string {
  const safe = summarizeText(value, 80);
  return safe.length > 0 ? safe : fallback;
}
