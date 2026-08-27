import type { AgentEvent } from "../src/agent/events.js";
import type { AgentRunResult } from "../src/agent/loop.js";

export interface CollectedAgentRun {
  readonly events: readonly AgentEvent[];
  readonly result: AgentRunResult;
}

export async function collectAgentRun(stream: AsyncGenerator<AgentEvent, AgentRunResult>): Promise<CollectedAgentRun> {
  const events: AgentEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}
