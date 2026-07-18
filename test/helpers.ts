import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../src/workflows/types.js";

export async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

export type ScriptedResponse =
  | { output: unknown }
  | { error: string }
  | { hang: true }
  | ((request: AgentStepRequest) => Promise<AgentStepSubmission> | AgentStepSubmission);

/**
 * Deterministic executor for engine tests. Responses are keyed by node id;
 * repeated visits to the same node consume queued responses in order.
 */
export class ScriptedExecutor implements AgentStepExecutor {
  readonly requests: AgentStepRequest[] = [];
  private readonly responses = new Map<string, ScriptedResponse[]>();

  respond(nodeId: string, ...responses: ScriptedResponse[]): this {
    const queue = this.responses.get(nodeId) ?? [];
    queue.push(...responses);
    this.responses.set(nodeId, queue);
    return this;
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    this.requests.push(request);
    const queue = this.responses.get(request.contract.nodeId) ?? [];
    const response = queue.length > 1 ? queue.shift() : queue[0];
    if (!response) {
      throw new Error(`No scripted response for node ${request.contract.nodeId}`);
    }
    if (typeof response === "function") {
      return await response(request);
    }
    if ("hang" in response) {
      return await new Promise<AgentStepSubmission>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if ("error" in response) {
      throw new Error(response.error);
    }
    const accepted = await request.accept(response.output);
    if (!accepted.ok) {
      throw new Error(`Scripted output rejected: ${accepted.error}`);
    }
    return { output: accepted.value };
  }
}
