import type { WorkflowProgressData, WorkflowUpdateRecord } from "./types.js";
import { validateProgressData } from "./updates.js";

export type ProgressConfidence = "low" | "medium" | "high";

export type ProgressEstimate = {
  key: string;
  data: WorkflowProgressData;
  sampleCount: number;
  delta?: number;
  rateLow?: number;
  rateMedian?: number;
  rateHigh?: number;
  remainingLowMs?: number;
  remainingMedianMs?: number;
  remainingHighMs?: number;
  confidence?: ProgressConfidence;
  sourceEstimatedFinishAt?: string;
  unavailableReason?: string;
};

export type ProgressSample = {
  at: string;
  data: WorkflowProgressData;
};

export type ProgressTrackState = {
  key: string;
  samples: ProgressSample[];
  estimate: ProgressEstimate;
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function estimateProgress(
  key: string,
  samples: ProgressSample[],
  now = new Date(),
): ProgressEstimate {
  if (samples.length === 0) throw new Error("progress estimation requires at least one sample");
  for (const sample of samples) validateProgressData(sample.data as Record<string, unknown>);
  const latest = samples.at(-1) as ProgressSample;
  const data = latest.data;
  const sourceFinish = validSourceFinish(latest, now);
  const base: ProgressEstimate = {
    key,
    data,
    sampleCount: 1,
    ...(sourceFinish !== undefined ? { sourceEstimatedFinishAt: sourceFinish } : {}),
  };
  if (TERMINAL.has(data.status)) return base;
  if (data.status === "waiting" || data.status === "blocked") {
    return sourceFinish === undefined
      ? { ...base, unavailableReason: `progress is ${data.status}` }
      : base;
  }
  if (data.completed === undefined || data.total === undefined) {
    return sourceFinish === undefined ? { ...base, unavailableReason: "total is unknown" } : base;
  }

  const epoch = currentEpoch(samples);
  const intervals: Array<{ rate: number; delta: number }> = [];
  for (let index = Math.max(1, epoch.length - 8); index < epoch.length; index += 1) {
    const previous = epoch[index - 1] as ProgressSample;
    const current = epoch[index] as ProgressSample;
    const elapsedMs = Date.parse(current.at) - Date.parse(previous.at);
    const previousCompleted = previous.data.completed;
    const currentCompleted = current.data.completed;
    if (elapsedMs <= 0 || previousCompleted === undefined || currentCompleted === undefined)
      continue;
    intervals.push({
      rate: (currentCompleted - previousCompleted) / elapsedMs,
      delta: currentCompleted - previousCompleted,
    });
  }
  base.sampleCount = intervals.length + 1;
  const latestDelta = intervals.at(-1)?.delta;
  if (latestDelta !== undefined) base.delta = latestDelta;
  if (intervals.length === 0) {
    return sourceFinish === undefined
      ? { ...base, unavailableReason: "needs another progress sample" }
      : base;
  }
  const rates = intervals.map((item) => item.rate).sort((a, b) => a - b);
  const median = quantile(rates, 0.5);
  const p25 = quantile(rates, 0.25);
  const p75 = quantile(rates, 0.75);
  const remaining = Math.max(0, data.total - data.completed);
  const positive = rates.filter((rate) => rate > 0);
  if (median <= 0 || positive.length === 0) {
    return sourceFinish === undefined
      ? { ...base, unavailableReason: "no positive progress rate" }
      : base;
  }
  const spread = (p75 - p25) / median;
  const confidence: ProgressConfidence =
    intervals.length >= 5
      ? spread <= 0.25
        ? "high"
        : spread <= 0.5
          ? "medium"
          : "low"
      : intervals.length >= 2 && spread <= 0.5
        ? "medium"
        : "low";
  const slow = p25 > 0 ? p25 : undefined;
  const fast = p75 > 0 ? p75 : median;
  return {
    ...base,
    ...(slow !== undefined ? { rateLow: slow } : {}),
    rateMedian: median,
    rateHigh: fast,
    remainingLowMs: remaining / fast,
    remainingMedianMs: remaining / median,
    ...(slow !== undefined ? { remainingHighMs: remaining / slow } : {}),
    confidence,
  };
}

export function progressTracksFromRecords(
  records: WorkflowUpdateRecord[],
  now = new Date(),
): ProgressTrackState[] {
  const grouped = new Map<string, ProgressSample[]>();
  for (const record of records) {
    if (record.type !== "progress") continue;
    const data = validateProgressData(record.data);
    const samples = grouped.get(record.key) ?? [];
    samples.push({ at: record.at, data });
    grouped.set(record.key, samples);
  }
  return [...grouped.entries()].map(([key, samples]) => ({
    key,
    samples,
    estimate: estimateProgress(key, samples, now),
  }));
}

export function formatProgressLine(estimate: ProgressEstimate, now = new Date()): string {
  const { data } = estimate;
  const label = data.label ?? estimate.key;
  const count =
    data.completed === undefined
      ? data.status
      : data.total === undefined
        ? `${formatNumber(data.completed)} ${data.unit ?? ""}`.trim()
        : `${formatNumber(data.completed)}/${formatNumber(data.total)} ${data.unit ?? ""}`.trim();
  let eta = "";
  if (estimate.sourceEstimatedFinishAt !== undefined) {
    eta = `source ETA ${formatRemaining(Date.parse(estimate.sourceEstimatedFinishAt) - now.getTime())}`;
  } else if (estimate.remainingMedianMs !== undefined) {
    const range =
      estimate.remainingLowMs !== undefined && estimate.remainingHighMs !== undefined
        ? `${formatRemaining(estimate.remainingLowMs)}–${formatRemaining(estimate.remainingHighMs)}`
        : formatRemaining(estimate.remainingMedianMs);
    eta = `ETA ${range}`;
  } else if (!TERMINAL.has(data.status)) {
    eta = `ETA unavailable${estimate.unavailableReason ? ` (${estimate.unavailableReason})` : ""}`;
  }
  return [label, count, eta].filter(Boolean).join("  ");
}

export function formatProgressReport(
  estimates: ProgressEstimate[],
  nextCheckMinutes?: number,
  now = new Date(),
): string {
  const lines: string[] = [];
  for (const estimate of prioritize(estimates)) {
    lines.push(`Progress: ${formatProgressLine(estimate, now)}`);
    if (estimate.rateMedian !== undefined && estimate.data.unit !== undefined) {
      const perMinute = estimate.rateMedian * 60_000;
      lines.push(`Rate: ${formatNumber(perMinute)} ${estimate.data.unit}/min`);
    }
  }
  if (nextCheckMinutes !== undefined) lines.push(`Next check: ${nextCheckMinutes} min`);
  return lines.join("\n");
}

export function formatRemaining(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 60_000) return `${Math.ceil(value / 1_000)}s`;
  if (value < 3_600_000) return `${Math.ceil(value / 60_000)}m`;
  if (value < 86_400_000) return `${(value / 3_600_000).toFixed(value < 36_000_000 ? 1 : 0)}h`;
  return `${(value / 86_400_000).toFixed(1)}d`;
}

function currentEpoch(samples: ProgressSample[]): ProgressSample[] {
  const epoch: ProgressSample[] = [];
  for (const sample of samples) {
    const prior = epoch.at(-1);
    if (prior !== undefined && resetsEpoch(prior.data, sample.data)) epoch.length = 0;
    epoch.push(sample);
  }
  return epoch;
}

function resetsEpoch(previous: WorkflowProgressData, next: WorkflowProgressData): boolean {
  return (
    previous.phase !== next.phase ||
    previous.unit !== next.unit ||
    previous.total !== next.total ||
    (previous.completed !== undefined &&
      next.completed !== undefined &&
      next.completed < previous.completed) ||
    (TERMINAL.has(previous.status) && !TERMINAL.has(next.status))
  );
}

function validSourceFinish(sample: ProgressSample, now: Date): string | undefined {
  const finish = sample.data.sourceEstimatedFinishAt;
  if (finish === undefined) return undefined;
  const finishMs = Date.parse(finish);
  const sourceMs = Date.parse(sample.data.sourceUpdatedAt ?? sample.at);
  return finishMs > sourceMs && finishMs > now.getTime() ? finish : undefined;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0] as number;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const a = sorted[lower] as number;
  const b = sorted[Math.min(lower + 1, sorted.length - 1)] as number;
  return a + (b - a) * fraction;
}

function prioritize(estimates: ProgressEstimate[]): ProgressEstimate[] {
  const weight = (item: ProgressEstimate) =>
    item.key === "overall"
      ? -2
      : item.data.status === "failed" || item.data.status === "blocked"
        ? -1
        : 0;
  return [...estimates].sort((a, b) => weight(a) - weight(b));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}
