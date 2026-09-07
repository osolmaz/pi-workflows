import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type LiveE2eOptions = {
  help?: boolean;
  keep: boolean;
  model?: string;
  maxOutputTokens?: number;
  piEntry: string;
  profile?: string;
  provider?: string;
  runtimeOnly: boolean;
};

export class RpcSession {
  constructor(child: ChildProcessWithoutNullStreams, context: { profile?: string; root: string });
  events: Record<string, unknown>[];
  expectedModelAbort?: (event: Record<string, unknown>) => Promise<boolean>;
  assertHealthy(): Promise<void>;
  stop(): Promise<void>;
}

export function isExpectedWorkflowAbort(
  event: Record<string, unknown>,
  entries: unknown,
  state: unknown,
  runId: string,
): boolean;
export function parseArgs(argv: string[]): LiveE2eOptions;
export function configureModelBudget(profile: string, options: LiveE2eOptions): Promise<void>;
export function assertSafeTempRoot(root: string, temporaryDirectory?: string): string;
export function removeTemporaryRoot(root: string, temporaryDirectory?: string): Promise<void>;
export function withTemporaryRoot<T>(
  operation: (root: string) => Promise<T>,
  options?: { keep?: boolean; temporaryDirectory?: string },
): Promise<T>;
export function main(argv?: string[]): Promise<void>;
