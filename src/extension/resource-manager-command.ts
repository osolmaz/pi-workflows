import type { JsonValue } from "../state/json.js";

export type ParsedResourceManagerArgs =
  | { kind: "list" }
  | { kind: "get"; resourceManager: string; key: string }
  | { kind: "apply"; resourceManager: string; key: string; spec: JsonValue }
  | { kind: "reconcile"; resourceManager: string; key: string }
  | { kind: "delete"; resourceManager: string; key: string };

const RESOURCE_MANAGER_USAGE =
  "Usage: /resource-manager [list|get <resource-manager> <key>|apply <resource-manager> <key> <json>|reconcile <resource-manager> <key>|delete <resource-manager> <key>]";

export function parseResourceManagerArgs(args: string): ParsedResourceManagerArgs {
  const trimmed = args.trim();
  if (trimmed.length === 0 || trimmed === "list") return { kind: "list" };

  const apply = trimmed.match(/^apply\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u);
  if (apply !== null) {
    let spec: JsonValue;
    try {
      spec = JSON.parse(apply[3] as string) as JsonValue;
    } catch (error) {
      throw new Error(
        `Invalid resource manager spec JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      kind: "apply",
      resourceManager: apply[1] as string,
      key: apply[2] as string,
      spec,
    };
  }

  const operation = trimmed.match(/^(get|reconcile|delete)\s+(\S+)\s+(\S+)$/u);
  if (operation !== null) {
    return {
      kind: operation[1] as "get" | "reconcile" | "delete",
      resourceManager: operation[2] as string,
      key: operation[3] as string,
    };
  }

  throw new Error(RESOURCE_MANAGER_USAGE);
}
