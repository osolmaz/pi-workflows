export type LiveE2eOptions = {
  help?: boolean;
  keep: boolean;
  model?: string;
  piEntry: string;
  profile?: string;
  provider?: string;
  runtimeOnly: boolean;
};

export function parseArgs(argv: string[]): LiveE2eOptions;
export function assertSafeTempRoot(root: string, temporaryDirectory?: string): string;
export function removeTemporaryRoot(root: string, temporaryDirectory?: string): Promise<void>;
export function withTemporaryRoot<T>(
  operation: (root: string) => Promise<T>,
  options?: { keep?: boolean; temporaryDirectory?: string },
): Promise<T>;
export function main(argv?: string[]): Promise<void>;
