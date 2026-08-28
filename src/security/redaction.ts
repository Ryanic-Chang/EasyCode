export const REDACTED_VALUE = "[已隐藏]";
export const TRUNCATION_MARKER = "…[已截断]";

const DEFAULT_MAX_STRING_BYTES = 32 * 1024;
const DEFAULT_MAX_METADATA_BYTES = 16 * 1024;
const DEFAULT_MAX_METADATA_DEPTH = 4;
const DEFAULT_MAX_METADATA_FIELDS = 64;
const DEFAULT_MAX_ARRAY_ITEMS = 32;
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

export interface RedactorOptions {
  readonly secrets?: readonly string[];
  readonly maxStringBytes?: number;
  readonly maxMetadataBytes?: number;
  readonly maxMetadataDepth?: number;
  readonly maxMetadataFields?: number;
  readonly maxArrayItems?: number;
}

export interface RedactedText {
  readonly value: string;
  readonly truncated: boolean;
}

export interface SanitizedMetadata {
  readonly value: Readonly<Record<string, unknown>>;
  readonly truncated: boolean;
}

interface MetadataBudget {
  remainingBytes: number;
  remainingFields: number;
  truncated: boolean;
}

const SENSITIVE_KEY =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|apikey|access[_-]?token|password|passwd|private[_-]?key|secret|token|signature)$/i;

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search.length === 0 ? value : value.split(search).join(replacement);
}

function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint === 9 || codePoint === 10 || codePoint === 13) {
        return character;
      }
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("");
}

function truncateUtf8(value: string, maximumBytes: number): RedactedText {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return { value, truncated: false };
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const available = Math.max(0, maximumBytes - markerBytes);
  let used = 0;
  const accepted: string[] = [];
  for (const { segment } of segmenter.segment(value)) {
    const bytes = Buffer.byteLength(segment, "utf8");
    if (used + bytes > available) {
      break;
    }
    accepted.push(segment);
    used += bytes;
  }
  return { value: `${accepted.join("")}${TRUNCATION_MARKER}`, truncated: true };
}

function redactKnownPatterns(value: string): string {
  return value
    .replace(/(authorization\s*:\s*(?:bearer\s+)?)[^\s,;\r\n]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/\bbearer\s+[a-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED_VALUE}`)
    .replace(/\bsk-[a-z0-9_.-]{8,}\b/gi, REDACTED_VALUE)
    .replace(
      /(\b(?:api[_-]?key|apikey|access[_-]?token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi,
      `$1${REDACTED_VALUE}`,
    )
    .replace(/((?:--)(?:token|signature)\s*=)[^\s,;]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|token|signature|secret)=)[^&#\s]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/(https?:\/\/)[^/@\s]+(?::[^/@\s]*)?@/gi, `$1${REDACTED_VALUE}@`);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export class Redactor {
  readonly #secrets: readonly string[];
  readonly #maxStringBytes: number;
  readonly #maxMetadataBytes: number;
  readonly #maxMetadataDepth: number;
  readonly #maxMetadataFields: number;
  readonly #maxArrayItems: number;

  constructor(options: RedactorOptions = {}) {
    this.#secrets = [...(options.secrets ?? [])]
      .filter((secret) => secret.length > 0)
      .sort((a, b) => b.length - a.length);
    this.#maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
    this.#maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
    this.#maxMetadataDepth = options.maxMetadataDepth ?? DEFAULT_MAX_METADATA_DEPTH;
    this.#maxMetadataFields = options.maxMetadataFields ?? DEFAULT_MAX_METADATA_FIELDS;
    this.#maxArrayItems = options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS;
  }

  redactText(value: string, maximumBytes = this.#maxStringBytes): string {
    return this.redactTextDetailed(value, maximumBytes).value;
  }

  redactTextDetailed(value: string, maximumBytes = this.#maxStringBytes): RedactedText {
    try {
      let redacted = stripControlCharacters(value);
      for (const secret of this.#secrets) {
        redacted = replaceAllLiteral(redacted, secret, REDACTED_VALUE);
      }
      redacted = redactKnownPatterns(redacted);
      return truncateUtf8(redacted, Math.max(Buffer.byteLength(TRUNCATION_MARKER, "utf8"), maximumBytes));
    } catch {
      return { value: REDACTED_VALUE, truncated: true };
    }
  }

  sanitizeMetadata(input: unknown): SanitizedMetadata {
    try {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { value: { easycodeSanitized: true, note: "metadata 不是可接受的 object" }, truncated: true };
      }
      const budget: MetadataBudget = {
        remainingBytes: this.#maxMetadataBytes,
        remainingFields: this.#maxMetadataFields,
        truncated: false,
      };
      const seen = new WeakSet<object>();
      seen.add(input);
      const value = this.#sanitizeObject(input, 0, budget, seen);
      seen.delete(input);
      if (budget.truncated) {
        value.easycodeTruncated = true;
      }
      return { value, truncated: budget.truncated };
    } catch {
      return { value: { easycodeSanitized: true, note: "metadata 无法安全读取" }, truncated: true };
    }
  }

  #consumeString(value: string, budget: MetadataBudget): string {
    const localLimit = Math.max(0, Math.min(this.#maxStringBytes, budget.remainingBytes));
    const redacted = this.redactTextDetailed(value, Math.max(Buffer.byteLength(TRUNCATION_MARKER, "utf8"), localLimit));
    const bytes = Buffer.byteLength(redacted.value, "utf8");
    budget.remainingBytes = Math.max(0, budget.remainingBytes - bytes);
    budget.truncated ||= redacted.truncated || bytes > localLimit;
    return redacted.value;
  }

  #sanitizeValue(value: unknown, depth: number, budget: MetadataBudget, seen: WeakSet<object>): unknown {
    if (value === null || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : "[非法数值已省略]";
    }
    if (typeof value === "string") {
      return this.#consumeString(value, budget);
    }
    if (typeof value !== "object") {
      budget.truncated = true;
      return "[非 JSON 值已省略]";
    }
    if (depth >= this.#maxMetadataDepth) {
      budget.truncated = true;
      return "[深层内容已省略]";
    }
    if (seen.has(value)) {
      budget.truncated = true;
      return "[循环引用已省略]";
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        const length = Math.min(value.length, this.#maxArrayItems);
        for (let index = 0; index < length && budget.remainingFields > 0; index += 1) {
          budget.remainingFields -= 1;
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          items.push(
            descriptor !== undefined && "value" in descriptor
              ? this.#sanitizeValue(descriptor.value, depth + 1, budget, seen)
              : "[不可读取]",
          );
        }
        if (value.length > length) {
          budget.truncated = true;
        }
        return items;
      }
      return this.#sanitizeObject(value, depth + 1, budget, seen);
    } finally {
      seen.delete(value);
    }
  }

  #sanitizeObject(
    input: object,
    depth: number,
    budget: MetadataBudget,
    seen: WeakSet<object>,
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    const keys = Object.keys(input);
    for (const key of keys) {
      if (budget.remainingFields <= 0 || budget.remainingBytes <= 0) {
        budget.truncated = true;
        break;
      }
      budget.remainingFields -= 1;
      const safeKey = this.redactText(key, 256);
      budget.remainingBytes = Math.max(0, budget.remainingBytes - Buffer.byteLength(safeKey, "utf8"));
      if (isSensitiveKey(key)) {
        output[safeKey] = REDACTED_VALUE;
        continue;
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(input, key);
      } catch {
        budget.truncated = true;
        output[safeKey] = "[不可读取]";
        continue;
      }
      if (descriptor === undefined || !("value" in descriptor)) {
        budget.truncated = true;
        output[safeKey] = "[不可读取]";
        continue;
      }
      output[safeKey] = this.#sanitizeValue(descriptor.value, depth, budget, seen);
    }
    return output;
  }
}

export const DEFAULT_REDACTOR = new Redactor();
