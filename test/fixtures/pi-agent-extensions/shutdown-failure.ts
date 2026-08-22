import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function shutdownFailure(pi: ExtensionAPI): void {
  pi.on("session_shutdown", () => {
    throw new Error("PRIVATE_PRECHECK_CLEANUP_FAILURE");
  });
}
