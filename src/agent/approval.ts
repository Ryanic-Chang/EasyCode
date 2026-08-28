export interface ApprovalRequest {
  readonly approvalId: string;
  readonly step: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly riskCategory: string;
  readonly actionSummary: string;
}

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly approved: boolean;
}

export interface ApprovalGate {
  request(request: ApprovalRequest, options: { readonly signal: AbortSignal }): Promise<ApprovalDecision>;
}

export interface ApprovalController {
  resolve(decision: ApprovalDecision): boolean;
  dispose(): void;
}

interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("确认已取消", "AbortError");
}

export class DenyApprovalGate implements ApprovalGate {
  request(request: ApprovalRequest, options: { readonly signal: AbortSignal }): Promise<ApprovalDecision> {
    options.signal.throwIfAborted();
    return Promise.resolve({ approvalId: request.approvalId, approved: false });
  }
}

export class ApprovalBroker implements ApprovalGate, ApprovalController {
  readonly #pending = new Map<string, PendingApproval>();
  #disposed = false;

  request(request: ApprovalRequest, options: { readonly signal: AbortSignal }): Promise<ApprovalDecision> {
    options.signal.throwIfAborted();
    if (this.#disposed) {
      return Promise.reject(abortReason());
    }
    if (this.#pending.has(request.approvalId)) {
      return Promise.reject(new Error("approval ID 重复"));
    }

    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(request.approvalId);
        if (pending === undefined) {
          return;
        }
        this.#pending.delete(request.approvalId);
        options.signal.removeEventListener("abort", onAbort);
        reject(abortReason(options.signal));
      };
      this.#pending.set(request.approvalId, { request, resolve, reject, signal: options.signal, onAbort });
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
      }
    });
  }

  resolve(decision: ApprovalDecision): boolean {
    const pending = this.#pending.get(decision.approvalId);
    if (pending === undefined) {
      return false;
    }
    this.#pending.delete(decision.approvalId);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve({ approvalId: pending.request.approvalId, approved: decision.approved === true });
    return true;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(abortReason());
    }
    this.#pending.clear();
  }

  pendingCount(): number {
    return this.#pending.size;
  }
}
