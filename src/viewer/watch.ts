import fs from "node:fs";
import path from "node:path";

export type Unsubscribe = () => void;

/** Watch the canonical database and its WAL with a polling fallback. */
export function watchStateDatabase(
  databasePath: string,
  onChange: () => void,
  options: { pollMs?: number; debounceMs?: number } = {},
): Unsubscribe {
  const pollMs = options.pollMs ?? 1_000;
  const debounceMs = options.debounceMs ?? 80;
  const directory = path.dirname(databasePath);
  const base = path.basename(databasePath);
  const relevant = new Set([base, `${base}-wal`, `${base}-shm`]);
  let debounceTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const fire = () => {
    if (closed) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange();
    }, debounceMs);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(directory, (_event, filename) => {
      if (filename === null || relevant.has(filename.toString())) fire();
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }

  const poller = setInterval(fire, pollMs);
  poller.unref?.();

  return () => {
    closed = true;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    clearInterval(poller);
    watcher?.close();
  };
}
