import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SESSION_BINDING_SCHEMA, type WorkflowRunStore } from "../workflows/store.js";
import type { ConversationRange } from "../workflows/types.js";

/**
 * Records the Pi conversation into the run bundle while a workflow runs, so
 * replay never depends on Pi's global session store. Uses only documented
 * read APIs (`ctx.sessionManager` getters); Pi session state is never
 * written.
 *
 * The recorder keeps a cursor into the current branch and appends every new
 * entry verbatim to `session/entries.ndjson`. Attempt linkage works through
 * marks: the executor takes a mark before delivering a prompt and asks for
 * the recorded range once the submission is accepted.
 */
export class SessionRecorder {
  private readonly store: WorkflowRunStore;
  private readonly runDir: string;
  private readonly runId: string;
  /** Id of the last branch entry already recorded (or seen at bind time). */
  private cursor: string | null = null;
  /** Ids of recorded entries, in recording order. */
  private readonly recorded: string[] = [];
  private bound = false;
  private stopped = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(store: WorkflowRunStore, runDir: string, runId: string) {
    this.store = store;
    this.runDir = runDir;
    this.runId = runId;
  }

  /**
   * Bind the run to the current conversation. Entries that existed before
   * the run started are not part of the run's record; the cursor starts at
   * the current leaf.
   */
  async bind(ctx: ExtensionContext): Promise<void> {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.cursor = ctx.sessionManager.getLeafId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    await this.store.writeSessionBinding(this.runDir, {
      schema: SESSION_BINDING_SCHEMA,
      runId: this.runId,
      piSessionId: ctx.sessionManager.getSessionId(),
      ...(sessionFile !== undefined ? { piSessionFile: sessionFile } : {}),
      cwd: ctx.cwd,
      boundAt: new Date().toISOString(),
    });
  }

  /**
   * Flush new entries on the current branch into the bundle. Serialized so
   * concurrent event handlers cannot interleave seq assignment.
   */
  record(ctx: ExtensionContext): Promise<void> {
    const task = this.chain.then(async () => {
      if (!this.bound || this.stopped) {
        return;
      }
      const branch = ctx.sessionManager.getBranch() as Array<{ id: string }>;
      let startIndex = 0;
      if (this.cursor !== null) {
        const cursorIndex = branch.findIndex((entry) => entry.id === this.cursor);
        if (cursorIndex === -1) {
          // The user branched away mid-run; recording continuity across
          // branch switches is best-effort. Re-anchor at the current leaf so
          // subsequent entries are still captured.
          this.cursor = branch.at(-1)?.id ?? this.cursor;
          return;
        }
        startIndex = cursorIndex + 1;
      }
      for (const entry of branch.slice(startIndex)) {
        await this.store.appendSessionEntry(
          this.runDir,
          entry as unknown as Record<string, unknown>,
        );
        this.recorded.push(entry.id);
        this.cursor = entry.id;
      }
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  /**
   * Stop recording and drain any in-flight flush. Awaited before the
   * terminal snapshot is persisted, so nothing can touch the bundle after a
   * run ends.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.chain;
  }

  /** Take a mark before delivering a prompt. */
  mark(): number {
    return this.recorded.length;
  }

  /** The inclusive entry range recorded since `mark`, if any. */
  rangeSince(mark: number): ConversationRange | undefined {
    if (this.recorded.length <= mark) {
      return undefined;
    }
    return {
      firstEntryId: this.recorded[mark] as string,
      lastEntryId: this.recorded.at(-1) as string,
    };
  }
}
