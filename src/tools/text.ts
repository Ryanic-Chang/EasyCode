import { open } from "node:fs/promises";

import { ToolDomainError } from "./errors.js";

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;

export interface BoundedText {
  readonly text: string;
  readonly bytes: number;
}

export async function readUtf8File(
  absolutePath: string,
  signal: AbortSignal,
  maximumBytes = MAX_TEXT_FILE_BYTES,
): Promise<BoundedText> {
  signal.throwIfAborted();
  const handle = await open(absolutePath, "r");
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) {
      throw new ToolDomainError("wrong_type", "目标不是普通文件。");
    }
    if (fileStats.size > maximumBytes) {
      throw new ToolDomainError("file_too_large", `文件超过 ${maximumBytes} bytes 的读取上限。`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      signal.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
      if (totalBytes > maximumBytes) {
        throw new ToolDomainError("file_too_large", `文件超过 ${maximumBytes} bytes 的读取上限。`);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }

    const contents = Buffer.concat(chunks, totalBytes);
    if (contents.includes(0)) {
      throw new ToolDomainError("binary_file", "目标包含二进制内容，拒绝读取。");
    }
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(contents), bytes: totalBytes };
    } catch {
      throw new ToolDomainError("invalid_utf8", "目标不是有效 UTF-8 文本。");
    }
  } finally {
    await handle.close();
  }
}

export function truncateUtf8(
  value: string,
  maximumBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return { value, truncated: false };
  }

  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return { value: result, truncated: true };
}

export function lineCount(value: string): number {
  return value.length === 0 ? 1 : value.split(/\r\n|\n|\r/).length;
}
