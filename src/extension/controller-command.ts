import type { JsonValue } from "../state/json.js";

export type ParsedControllerArgs =
  | { kind: "list" }
  | { kind: "get"; controller: string; key: string }
  | { kind: "apply"; controller: string; key: string; spec: JsonValue }
  | { kind: "reconcile"; controller: string; key: string }
  | { kind: "delete"; controller: string; key: string };

const CONTROLLER_USAGE =
  "Usage: /controller [list|get <controller> <key>|apply <controller> <key> <json>|reconcile <controller> <key>|delete <controller> <key>]";

export function parseControllerArgs(args: string): ParsedControllerArgs {
  const trimmed = args.trim();
  if (trimmed.length === 0 || trimmed === "list") return { kind: "list" };

  const apply = trimmed.match(/^apply\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u);
  if (apply !== null) {
    let spec: JsonValue;
    try {
      spec = JSON.parse(apply[3] as string) as JsonValue;
    } catch (error) {
      throw new Error(
        `Invalid controller spec JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      kind: "apply",
      controller: apply[1] as string,
      key: apply[2] as string,
      spec,
    };
  }

  const operation = trimmed.match(/^(get|reconcile|delete)\s+(\S+)\s+(\S+)$/u);
  if (operation !== null) {
    return {
      kind: operation[1] as "get" | "reconcile" | "delete",
      controller: operation[2] as string,
      key: operation[3] as string,
    };
  }

  throw new Error(CONTROLLER_USAGE);
}
