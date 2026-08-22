import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function childShutdownFailure(pi: ExtensionAPI): void {
  let started = false;
  pi.on("session_start", () => {
    started = true;
  });
  pi.on("session_shutdown", () => {
    if (started) throw new Error("PRIVATE_CHILD_CLEANUP_FAILURE");
  });
}
