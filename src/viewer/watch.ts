import fs from "node:fs";

export type Unsubscribe = () => void;

/**
 * Watch a directory tree for changes with a polling fallback. `onChange` is
 * debounced so bursts of writes trigger one refresh.
 */
export function watchRunsDir(
  dir: string,
  onChange: () => void,
  options: { pollMs?: number; debounceMs?: number } = {},
): Unsubscribe {
  const pollMs = options.pollMs ?? 1_000;
  const debounceMs = options.debounceMs ?? 80;
  let debounceTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const fire = () => {
    if (closed) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange();
    }, debounceMs);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, { recursive: true }, fire);
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }

  // Polling fallback covers platforms without recursive fs.watch and missed events.
  const poller = setInterval(fire, pollMs);
  poller.unref?.();

  return () => {
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    clearInterval(poller);
    watcher?.close();
  };
}
