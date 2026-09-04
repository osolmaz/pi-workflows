import {
  conditionFalse,
  conditionTrue,
  conditionUnknown,
  defineResourceManager,
  type ChildWorkflowRecord,
} from "@osolmaz/pi-workflows/resource-managers";

type PullRequestSpec = {
  apiBaseUrl: string;
  repository: string;
  number: number;
  expectedHeadSha: string;
  repairWorkflow: string;
  mergeApproved: boolean;
};

type PullRequestStatus = {
  phase: "observing" | "repairing" | "waiting" | "ready" | "merged" | "blocked";
  observedHeadSha?: string;
};

type PullRequest = {
  merged: boolean;
  merge_commit_sha?: string | null;
  head: { sha: string };
};

type CommitStatus = {
  state: "error" | "failure" | "pending" | "success";
};

export default defineResourceManager<PullRequestSpec, PullRequestStatus>({
  name: "pull-request",
  initialStatus: () => ({ phase: "observing" }),

  async reconcile(ctx, resource) {
    const client = new GitHubClient(resource.spec.apiBaseUrl, resource.spec.repository);
    const pullRequest = await client.pullRequest(resource.spec.number, ctx.signal);
    const observed = { observedHeadSha: pullRequest.head.sha };

    if (pullRequest.merged) {
      return ctx.settled({
        resourceManagerStatus: { phase: "merged", ...observed },
        conditions: [conditionTrue("Ready", "Merged")],
        workflowRun: null,
      });
    }
    if (pullRequest.head.sha !== resource.spec.expectedHeadSha) {
      return ctx.settled({
        resourceManagerStatus: { phase: "blocked", ...observed },
        conditions: [conditionFalse("Ready", "HeadChanged")],
      });
    }

    const child = await ctx.workflows.ensure({
      requestKey: `repair:${resource.metadata.generation}:${pullRequest.head.sha}`,
      workflow: resource.spec.repairWorkflow,
      input: {
        repository: resource.spec.repository,
        number: resource.spec.number,
        expectedHeadSha: pullRequest.head.sha,
      },
    });
    const workflowRun = workflowReference(child);
    if (child.state === "failed") {
      return ctx.settled({
        resourceManagerStatus: { phase: "blocked", ...observed },
        conditions: [conditionFalse("Ready", "RepairFailed", child.error)],
        workflowRun,
      });
    }
    if (child.state !== "succeeded") {
      return ctx.requeueAfter(5_000, {
        resourceManagerStatus: { phase: "repairing", ...observed },
        conditions: [conditionUnknown("Ready", "RepairRunning")],
        workflowRun,
      });
    }

    const checks = await client.commitStatus(pullRequest.head.sha, ctx.signal);
    if (checks.state !== "success") {
      return ctx.requeueAfter(30_000, {
        resourceManagerStatus: { phase: "waiting", ...observed },
        conditions: [conditionUnknown("Ready", "ChecksPending", checks.state)],
        workflowRun,
      });
    }
    if (!resource.spec.mergeApproved) {
      return ctx.settled({
        resourceManagerStatus: { phase: "ready", ...observed },
        conditions: [conditionFalse("Ready", "ApprovalRequired")],
        workflowRun,
      });
    }

    const effect = await ctx.effects.ensure({
      key: `merge:${resource.metadata.generation}:${pullRequest.head.sha}`,
      kind: "github-merge",
      request: {
        repository: resource.spec.repository,
        number: resource.spec.number,
        expectedHeadSha: pullRequest.head.sha,
      },
      observe: async (signal) => {
        const latest = await client.pullRequest(resource.spec.number, signal);
        return latest.merged
          ? {
              state: "applied",
              ...(latest.merge_commit_sha ? { externalRef: latest.merge_commit_sha } : {}),
            }
          : { state: "not_applied" };
      },
      apply: async (signal) =>
        await client.merge(resource.spec.number, pullRequest.head.sha, signal),
    });
    if (effect.state === "rejected") {
      return ctx.settled({
        resourceManagerStatus: { phase: "blocked", ...observed },
        conditions: [conditionFalse("Ready", "MergeRejected", effect.error)],
        workflowRun,
      });
    }
    if (effect.state === "indeterminate") {
      return ctx.requeueAfter(10_000, {
        resourceManagerStatus: { phase: "waiting", ...observed },
        conditions: [conditionUnknown("Ready", "MergeUncertain", effect.error)],
        workflowRun,
      });
    }
    return ctx.requeue({
      resourceManagerStatus: { phase: "waiting", ...observed },
      conditions: [conditionUnknown("Ready", "MergeSubmitted")],
      workflowRun,
    });
  },
});

class GitHubClient {
  private readonly baseUrl: URL;
  private readonly owner: string;
  private readonly repository: string;

  constructor(baseUrl: string, repository: string) {
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    const parts = repository.split("/");
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
      throw new Error(`Invalid repository: ${repository}`);
    }
    this.owner = parts[0] as string;
    this.repository = parts[1] as string;
  }

  async pullRequest(number: number, signal: AbortSignal): Promise<PullRequest> {
    return await this.request<PullRequest>(`pulls/${number}`, { signal });
  }

  async commitStatus(sha: string, signal: AbortSignal): Promise<CommitStatus> {
    return await this.request<CommitStatus>(`commits/${encodeURIComponent(sha)}/status`, {
      signal,
    });
  }

  async merge(number: number, headSha: string, signal: AbortSignal) {
    const response = await this.rawRequest(`pulls/${number}/merge`, {
      method: "PUT",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: headSha }),
    });
    const body = (await response.json()) as {
      merged?: boolean;
      message?: string;
      sha?: string;
    };
    if (!response.ok || body.merged !== true) {
      return { state: "rejected" as const, error: body.message ?? `HTTP ${response.status}` };
    }
    return {
      state: "applied" as const,
      ...(body.sha !== undefined ? { externalRef: body.sha } : {}),
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.rawRequest(path, init);
    if (!response.ok) {
      throw new Error(`GitHub request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async rawRequest(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(
      `repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/${path}`,
      this.baseUrl,
    );
    return await fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        ...init.headers,
      },
    });
  }
}

function workflowReference(child: ChildWorkflowRecord) {
  return {
    requestId: child.requestId,
    ...(child.runId !== undefined ? { runId: child.runId } : {}),
    state: child.state,
    attempt: child.attempt,
  };
}
