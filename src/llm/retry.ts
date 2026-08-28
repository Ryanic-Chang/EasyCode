export const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
export const MAX_RETRY_AFTER_MS = 10_000;
const JITTER_RATIO = 0.2;

export type RetrySleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

export interface RetryPolicyConfig {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs?: number;
}

export interface RetryPolicyOptions {
  readonly random?: () => number;
  readonly sleep?: RetrySleep;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("操作已取消", "AbortError");
}

export function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  let delay: number;
  if (/^\d+$/.test(trimmed)) {
    delay = Number(trimmed) * 1000;
  } else {
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) {
      return undefined;
    }
    delay = timestamp - nowMs;
  }
  if (!Number.isFinite(delay) || delay < 0) {
    return undefined;
  }
  return Math.min(Math.round(delay), MAX_RETRY_AFTER_MS);
}

export class RetryPolicy {
  readonly maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #random: () => number;
  readonly #sleep: RetrySleep;

  constructor(config: RetryPolicyConfig, options: RetryPolicyOptions = {}) {
    if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 5) {
      throw new RangeError("maxRetries 必须是 0–5 的整数");
    }
    if (!Number.isInteger(config.baseDelayMs) || config.baseDelayMs < 1) {
      throw new RangeError("baseDelayMs 必须是正整数");
    }
    const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    if (!Number.isInteger(maxDelayMs) || maxDelayMs < config.baseDelayMs) {
      throw new RangeError("maxDelayMs 必须是不小于 baseDelayMs 的整数");
    }
    this.maxRetries = config.maxRetries;
    this.#baseDelayMs = config.baseDelayMs;
    this.#maxDelayMs = maxDelayMs;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  delayFor(retryNumber: number, retryAfterMs?: number): number {
    if (!Number.isInteger(retryNumber) || retryNumber < 1) {
      throw new RangeError("retryNumber 必须是正整数");
    }
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (retryNumber - 1));
    const random = Math.min(1, Math.max(0, this.#random()));
    const jittered = Math.round(exponential * (1 - JITTER_RATIO + 2 * JITTER_RATIO * random));
    return Math.min(this.#maxDelayMs, Math.max(jittered, retryAfterMs ?? 0));
  }

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    return this.#sleep(delayMs, signal);
  }
}
