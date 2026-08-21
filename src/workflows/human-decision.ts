import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  digestCanonical,
  normalizeDecisionPresentation,
  validateHumanDecisionRequestIntegrity,
} from "./decision-presentation.js";
import { checkpoint } from "./definition.js";
import type {
  AcceptedHumanDecision,
  CheckpointNodeDefinition,
  HumanDecisionChoice,
  HumanDecisionAudience,
  HumanDecisionCancellationRecord,
  HumanDecisionChoiceMap,
  HumanDecisionChannelRequest,
  HumanDecisionContinuationRecord,
  HumanDecisionDeliveryRecord,
  HumanDecisionPrompt,
  HumanDecisionRequest,
  HumanDecisionResponse,
  HumanDecisionSettlementRecord,
  HumanDecisionSubmission,
  HumanDecisionTextInput,
  HumanDecisionTimeout,
  ResolvedHumanDecision,
  WorkflowNodeCommon,
  WorkflowNodeContext,
} from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const CHOICE_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_MIN_LENGTH = 1;
const DEFAULT_MAX_LENGTH = 4_000;

export type HumanDecisionChoiceDefinition = Omit<HumanDecisionChoice, "input"> & {
  input?: HumanDecisionTextInput;
};

export type HumanDecisionDefinition<TChoices extends HumanDecisionChoiceMap> =
  WorkflowNodeCommon & {
    audience: HumanDecisionAudience;
    choices: TChoices;
    request: (context: WorkflowNodeContext) => HumanDecisionPrompt | Promise<HumanDecisionPrompt>;
    onTimeout?:
      | { afterMs: number; response: HumanDecisionResponseFor<TChoices> }
      | ((
          context: WorkflowNodeContext,
        ) =>
          | { afterMs: number; response: HumanDecisionResponseFor<TChoices> }
          | undefined
          | Promise<{ afterMs: number; response: HumanDecisionResponseFor<TChoices> } | undefined>);
  };

export type HumanDecisionResponseFor<TChoices extends HumanDecisionChoiceMap> = {
  [K in keyof TChoices & string]: TChoices[K] extends { input: HumanDecisionTextInput }
    ? { choice: K; input: Record<TChoices[K]["input"]["name"], string> }
    : { choice: K };
}[keyof TChoices & string];

export function textInput<const TName extends string>(options: {
  name: TName;
  prompt: string;
  minLength?: number;
  maxLength?: number;
}): HumanDecisionTextInput & { name: TName } {
  const name = requireSimpleId(options.name, "Human decision text input name");
  const prompt = requireString(options.prompt, "Human decision text input prompt");
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (!Number.isInteger(minLength) || minLength < 0) {
    throw new Error("Human decision text input minLength must be a non-negative integer");
  }
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength < minLength) {
    throw new Error(
      "Human decision text input maxLength must be a positive integer at least minLength",
    );
  }
  return { kind: "text", name: name as TName, prompt, minLength, maxLength };
}

export function choice<const TChoice extends HumanDecisionChoiceDefinition>(
  definition: TChoice,
): TChoice {
  validateChoice(definition, "choice");
  return definition;
}

export function defineHumanChoices<const TChoices extends HumanDecisionChoiceMap>(
  choices: TChoices,
): TChoices {
  validateChoices(choices);
  return Object.freeze({ ...choices });
}

/** Build a typed verified-human gate that still executes as a checkpoint. */
export function humanDecision<const TChoices extends HumanDecisionChoiceMap>(
  definition: HumanDecisionDefinition<TChoices>,
): CheckpointNodeDefinition & { readonly __humanChoices?: TChoices } {
  const audience =
    typeof definition.audience === "function"
      ? definition.audience
      : requireSimpleId(definition.audience, "Human decision audience");
  validateChoices(definition.choices);
  if (typeof definition.request !== "function") {
    throw new Error("Human decision request must be a function");
  }
  const { choices, request, onTimeout, ...common } = definition;
  if (
    onTimeout !== undefined &&
    typeof onTimeout !== "function" &&
    (typeof onTimeout.afterMs !== "number" ||
      !Number.isFinite(onTimeout.afterMs) ||
      onTimeout.afterMs <= 0)
  ) {
    throw new Error("Human decision onTimeout afterMs must be a finite positive number");
  }
  return checkpoint({
    ...common,
    summary: typeof audience === "string" ? `human decision for ${audience}` : "human decision",
    humanDecision: {
      audience,
      choices,
      request,
      ...(onTimeout !== undefined ? { onTimeout } : {}),
    },
  }) as CheckpointNodeDefinition & { readonly __humanChoices?: TChoices };
}

export function humanDecisionEdge<
  const TChoices extends HumanDecisionChoiceMap,
  const TFrom extends string,
  const TCases extends Record<keyof TChoices & string, string>,
>(args: {
  from: TFrom;
  choices: TChoices;
  cases: TCases & Record<Exclude<keyof TCases, keyof TChoices>, never>;
}): { from: TFrom; switch: { on: "$.choice"; cases: TCases } } {
  validateChoices(args.choices);
  for (const key of Object.keys(args.choices)) {
    if (!Object.hasOwn(args.cases, key)) {
      throw new Error(`Human decision edge is missing case for choice ${JSON.stringify(key)}`);
    }
  }
  for (const key of Object.keys(args.cases)) {
    if (!Object.hasOwn(args.choices, key)) {
      throw new Error(`Human decision edge has unknown case ${JSON.stringify(key)}`);
    }
  }
  return { from: args.from, switch: { on: "$.choice", cases: args.cases } };
}

export function createHumanDecisionRequest(input: {
  runId: string;
  workflowName: string;
  nodeId: string;
  attemptId: string;
  contract: { audience: string; choices: HumanDecisionChoiceMap };
  prompt: HumanDecisionPrompt;
  timeout?: HumanDecisionTimeout;
  createdAt?: string;
}): HumanDecisionRequest {
  validateChoices(input.contract.choices);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const title = requireString(input.prompt.title, "Human decision title");
  if (input.timeout !== undefined && input.prompt.expiresAt !== undefined) {
    throw new Error("Human decision request cannot combine expiresAt with onTimeout");
  }
  if (
    input.timeout !== undefined &&
    (typeof input.timeout.afterMs !== "number" ||
      !Number.isFinite(input.timeout.afterMs) ||
      input.timeout.afterMs <= 0)
  ) {
    throw new Error("Human decision onTimeout afterMs must be a finite positive number");
  }
  const defaultResponse =
    input.timeout === undefined
      ? undefined
      : validateResponseForChoices(input.contract.choices, input.timeout.response);
  const expiresAt =
    input.timeout === undefined
      ? validateExpiry(input.prompt.expiresAt, createdAt)
      : new Date(Date.parse(createdAt) + input.timeout.afterMs).toISOString();
  const common = {
    runId: input.runId,
    workflowName: input.workflowName,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    audience: requireSimpleId(input.contract.audience, "Human decision audience"),
    title,
    choices: input.contract.choices,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(defaultResponse !== undefined ? { defaultResponse } : {}),
  } as const;
  validatePresentedText(title, "Human decision title");
  validatePresentedChoices(input.contract.choices);
  const prompt = input.prompt;
  assertJsonValue(prompt.subject, "Human decision subject");
  const presentation = normalizeDecisionPresentation(prompt.presentation);
  const revision = prompt.revision ?? 1;
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("Human decision revision must be a positive integer");
  }
  const basis = {
    schema: "pi-workflows.human-decision-request.v1" as const,
    ...common,
    subject: prompt.subject,
    presentation,
    revision,
  };
  const subjectDigest = digestCanonical(prompt.subject);
  const presentationDigest = digestCanonical(presentation);
  const requestDigest = digestCanonical(basis);
  const decisionId = decisionIdFor(input, requestDigest);
  return {
    ...basis,
    decisionId,
    requestDigest,
    subjectDigest,
    presentationDigest,
    createdAt,
  };
}

function decisionIdFor(
  input: Pick<Parameters<typeof createHumanDecisionRequest>[0], "runId" | "nodeId" | "attemptId">,
  requestDigest: string,
): string {
  return `decision-${digestHex({
    runId: input.runId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    requestDigest,
  }).slice(0, 40)}`;
}

export function validateHumanDecisionResponse(
  request: HumanDecisionRequest,
  value: unknown,
): HumanDecisionResponse {
  return validateResponseForChoices(request.choices, value);
}

function validateResponseForChoices(
  choices: HumanDecisionChoiceMap,
  value: unknown,
): HumanDecisionResponse {
  const response = requireRecord(value, "Human decision response");
  const selected = response.choice;
  if (typeof selected !== "string" || !Object.hasOwn(choices, selected)) {
    throw new Error(`Human decision choice ${JSON.stringify(selected)} is not available`);
  }
  const selectedChoice = choices[selected];
  if (!selectedChoice) throw new Error("Human decision choice contract is missing");
  if (selectedChoice.input === undefined) {
    if (response.input !== undefined) {
      throw new Error(`Human decision choice ${selected} does not accept input`);
    }
    return { choice: selected };
  }
  const rawInput = requireRecord(response.input, `Human decision choice ${selected} input`);
  const keys = Object.keys(rawInput);
  if (keys.length !== 1 || keys[0] !== selectedChoice.input.name) {
    throw new Error(
      `Human decision choice ${selected} input must contain only ${selectedChoice.input.name}`,
    );
  }
  const text = rawInput[selectedChoice.input.name];
  if (typeof text !== "string") {
    throw new Error(`Human decision choice ${selected} input must be text`);
  }
  if (
    text.length < selectedChoice.input.minLength ||
    text.length > selectedChoice.input.maxLength
  ) {
    throw new Error(
      `Human decision choice ${selected} input length must be ${selectedChoice.input.minLength} through ${selectedChoice.input.maxLength}`,
    );
  }
  return { choice: selected, input: { [selectedChoice.input.name]: text } };
}

export function validateHumanDecisionSubmission(
  request: HumanDecisionRequest,
  value: HumanDecisionSubmission,
): HumanDecisionSubmission {
  if (value.decisionId !== request.decisionId || value.requestDigest !== request.requestDigest) {
    throw new Error("Human decision answer is stale or belongs to another request");
  }
  if (request.expiresAt !== undefined && Date.parse(request.expiresAt) <= Date.now()) {
    throw new Error("Human decision request has expired");
  }
  const response = validateHumanDecisionResponse(request, value);
  const source = requireRecord(value.source, "Human decision source");
  const channel = requireChannelId(source.channel, "Human decision channel");
  const actorId = requireString(source.actorId, "Human decision actor");
  const eventId = requireString(source.eventId, "Human decision event");
  const idempotencyKey = requireString(value.idempotencyKey, "Human decision idempotency key");
  return {
    decisionId: request.decisionId,
    requestDigest: request.requestDigest,
    ...response,
    source: { channel, actorId, eventId },
    idempotencyKey,
  };
}

export function humanDecisionStateRoot(runsRoot: string): string {
  return path.basename(runsRoot) === "runs"
    ? path.join(path.dirname(runsRoot), "decisions")
    : `${runsRoot}.decisions`;
}

export type HumanDecisionAcceptance =
  | { status: "accepted" | "adopted"; decision: ResolvedHumanDecision }
  | { status: "conflict"; decision: ResolvedHumanDecision };

type HumanDecisionResolution =
  | {
      schema: "pi-workflows.human-decision-resolution.v1";
      outcome: "accepted";
      decision: ResolvedHumanDecision;
    }
  | {
      schema: "pi-workflows.human-decision-resolution.v1";
      outcome: "cancelled";
      cancellation: HumanDecisionCancellationRecord;
    };

const INCOMPATIBLE_HUMAN_DECISION_STATE =
  "Human decision state uses an incompatible alpha contract; reset the affected workflow run and decision state.";

function requireCurrentDecision(value: unknown): ResolvedHumanDecision {
  const decision = requireRecord(value, "Resolved human decision");
  if (
    decision.schema !== "pi-workflows.human-decision-accepted.v1" ||
    !Object.hasOwn(decision, "subjectDigest") ||
    !Object.hasOwn(decision, "presentationDigest") ||
    !Object.hasOwn(decision, "revision")
  ) {
    throw new Error(INCOMPATIBLE_HUMAN_DECISION_STATE);
  }
  return value as ResolvedHumanDecision;
}

function requireCurrentResolution(value: unknown): HumanDecisionResolution | null {
  if (value === null) return null;
  const resolution = requireRecord(value, "Human decision resolution");
  if (resolution.schema !== "pi-workflows.human-decision-resolution.v1") {
    throw new Error(INCOMPATIBLE_HUMAN_DECISION_STATE);
  }
  if (resolution.outcome === "accepted") {
    return {
      ...resolution,
      decision: requireCurrentDecision(resolution.decision),
    } as HumanDecisionResolution;
  }
  if (resolution.outcome === "cancelled") return value as HumanDecisionResolution;
  throw new Error(INCOMPATIBLE_HUMAN_DECISION_STATE);
}

function requireCurrentDelivery(value: unknown): HumanDecisionDeliveryRecord {
  const delivery = requireRecord(value, "Human decision delivery");
  if (
    delivery.schema !== "pi-workflows.human-decision-delivery.v1" ||
    !Object.hasOwn(delivery, "presentationDigest") ||
    !Object.hasOwn(delivery, "phase")
  ) {
    throw new Error(INCOMPATIBLE_HUMAN_DECISION_STATE);
  }
  return value as HumanDecisionDeliveryRecord;
}

export class HumanDecisionStore {
  readonly root: string;

  constructor(runsRoot: string) {
    this.root = humanDecisionStateRoot(runsRoot);
  }

  decisionDir(decisionId: string): string {
    assertId(decisionId, "decision id");
    return path.join(this.root, decisionId);
  }

  async createRequest(request: HumanDecisionRequest): Promise<"created" | "adopted"> {
    validateHumanDecisionRequestIntegrity(request);
    return await writeImmutableJson(
      path.join(this.decisionDir(request.decisionId), "request.json"),
      request,
    );
  }

  async readRequest(decisionId: string): Promise<HumanDecisionRequest | null> {
    const request = (await readJson(
      path.join(this.decisionDir(decisionId), "request.json"),
    )) as HumanDecisionRequest | null;
    return request === null ? null : validateHumanDecisionRequestIntegrity(request);
  }

  async recordDelivery(
    request: HumanDecisionRequest | HumanDecisionChannelRequest,
    channel: string,
    value: HumanDecisionDeliveryRecord,
  ): Promise<"created" | "adopted"> {
    const safeChannel = requireSimpleId(channel, "Human decision channel");
    const attemptId = requireString(value.attemptId, "Human decision delivery attempt");
    assertId(attemptId, "delivery attempt id");
    return await writeImmutableJson(
      path.join(
        this.decisionDir(request.decisionId),
        "deliveries",
        safeChannel,
        `${attemptId}.json`,
      ),
      value,
    );
  }

  async accept(
    request: HumanDecisionRequest,
    submission: HumanDecisionSubmission,
  ): Promise<HumanDecisionAcceptance> {
    validateHumanDecisionRequestIntegrity(request);
    const cancellation = await this.readCancellation(request.decisionId);
    if (cancellation !== null) {
      throw new Error(`Human decision request was ${cancellation.reason}`);
    }
    const normalized = validateHumanDecisionSubmission(request, submission);
    let attemptedAt = new Date().toISOString();
    const attemptId = digestHex({
      decisionId: request.decisionId,
      idempotencyKey: normalized.idempotencyKey,
    }).slice(0, 40);
    const attemptPath = path.join(
      this.decisionDir(request.decisionId),
      "answers",
      `${attemptId}.json`,
    );
    const attempt = {
      schema: "pi-workflows.human-decision-answer-attempt.v1",
      attemptId,
      attemptedAt,
      ...normalized,
    };
    const attemptWrite = await writeImmutableJson(attemptPath, attempt, false);
    if (attemptWrite === "adopted") {
      const existingAttempt = requireRecord(
        await readJson(attemptPath),
        "Existing human decision answer attempt",
      );
      const existingSubmission = {
        decisionId: existingAttempt.decisionId,
        requestDigest: existingAttempt.requestDigest,
        choice: existingAttempt.choice,
        ...(existingAttempt.input !== undefined ? { input: existingAttempt.input } : {}),
        source: existingAttempt.source,
        idempotencyKey: existingAttempt.idempotencyKey,
      };
      if (canonicalJson(existingSubmission) !== canonicalJson(normalized)) {
        throw new Error("Human decision idempotency key was reused for a different answer");
      }
      attemptedAt = requireString(existingAttempt.attemptedAt, "answer attempt time");
    }
    const response = validateHumanDecisionResponse(request, normalized);
    const commonDecision = {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      response,
      provenance: "human" as const,
      source: normalized.source,
      idempotencyKey: normalized.idempotencyKey,
      acceptedAt: attemptedAt,
      answerDigest: digest({ response, source: normalized.source }),
    };
    const decision: AcceptedHumanDecision = {
      schema: "pi-workflows.human-decision-accepted.v1",
      ...commonDecision,
      subjectDigest: request.subjectDigest,
      presentationDigest: request.presentationDigest,
      revision: request.revision,
    };
    const resolutionPath = path.join(this.decisionDir(request.decisionId), "resolution.json");
    const resolution: HumanDecisionResolution = {
      schema: "pi-workflows.human-decision-resolution.v1",
      outcome: "accepted",
      decision,
    };
    const result = await writeImmutableJson(resolutionPath, resolution, false);
    const winner =
      result === "created"
        ? resolution
        : ((await readJson(resolutionPath)) as HumanDecisionResolution | null);
    if (winner === null) throw new Error("Human decision resolution became unreadable");
    const winningCancellation = await this.readCancellation(request.decisionId);
    if (winningCancellation !== null) {
      throw new Error(`Human decision request was ${winningCancellation.reason}`);
    }
    if (winner.outcome === "cancelled") {
      throw new Error(`Human decision request was ${winner.cancellation.reason}`);
    }
    const existing = winner.decision;
    await writeImmutableJson(
      path.join(this.decisionDir(request.decisionId), "accepted.json"),
      existing,
    );
    if (result === "created") return { status: "accepted", decision: existing };
    if (canonicalJson(existing) === canonicalJson(decision)) {
      return { status: "adopted", decision: existing };
    }
    if (
      existing.provenance === "human" &&
      existing.idempotencyKey === decision.idempotencyKey &&
      canonicalJson(existing.response) === canonicalJson(decision.response) &&
      canonicalJson(existing.source) === canonicalJson(decision.source)
    ) {
      return { status: "adopted", decision: existing };
    }
    return { status: "conflict", decision: existing };
  }

  async resolveTimeout(
    request: HumanDecisionRequest,
    now = new Date(),
  ): Promise<HumanDecisionAcceptance> {
    validateHumanDecisionRequestIntegrity(request);
    if (request.expiresAt === undefined || request.defaultResponse === undefined) {
      throw new Error("Human decision request has no timeout default");
    }
    if (Date.parse(request.expiresAt) > now.getTime()) {
      throw new Error("Human decision timeout default is not eligible yet");
    }
    const response = validateHumanDecisionResponse(request, request.defaultResponse);
    const commonDecision = {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      response,
      provenance: "timeout" as const,
      acceptedAt: now.toISOString(),
      answerDigest: digest({
        provenance: "timeout",
        requestDigest: request.requestDigest,
        response,
      }),
    };
    const decision: ResolvedHumanDecision = {
      schema: "pi-workflows.human-decision-accepted.v1",
      ...commonDecision,
      subjectDigest: request.subjectDigest,
      presentationDigest: request.presentationDigest,
      revision: request.revision,
    };
    const resolutionPath = path.join(this.decisionDir(request.decisionId), "resolution.json");
    const resolution: HumanDecisionResolution = {
      schema: "pi-workflows.human-decision-resolution.v1",
      outcome: "accepted",
      decision,
    };
    const result = await writeImmutableJson(resolutionPath, resolution, false);
    const winner =
      result === "created"
        ? resolution
        : ((await readJson(resolutionPath)) as HumanDecisionResolution | null);
    if (winner === null) throw new Error("Human decision resolution became unreadable");
    const winningCancellation = await this.readCancellation(request.decisionId);
    if (winningCancellation !== null) {
      throw new Error(`Human decision request was ${winningCancellation.reason}`);
    }
    if (winner.outcome === "cancelled") {
      throw new Error(`Human decision request was ${winner.cancellation.reason}`);
    }
    const existing = winner.decision;
    await writeImmutableJson(
      path.join(this.decisionDir(request.decisionId), "accepted.json"),
      existing,
    );
    if (result === "created") return { status: "accepted", decision: existing };
    return canonicalJson(existing) === canonicalJson(decision)
      ? { status: "adopted", decision: existing }
      : { status: "conflict", decision: existing };
  }

  async listDeliveries(
    decisionId: string,
    channel: string,
  ): Promise<HumanDecisionDeliveryRecord[]> {
    const safeChannel = requireSimpleId(channel, "Human decision channel");
    const directory = path.join(this.decisionDir(decisionId), "deliveries", safeChannel);
    return (await readJsonDirectory(directory)).map(requireCurrentDelivery);
  }

  async recordSettlement(
    decisionId: string,
    channel: string,
    value: HumanDecisionSettlementRecord,
  ): Promise<"created" | "adopted"> {
    const safeChannel = requireSimpleId(channel, "Human decision channel");
    assertId(value.attemptId, "settlement attempt id");
    return await writeImmutableJson(
      path.join(
        this.decisionDir(decisionId),
        "settlements",
        safeChannel,
        `${value.attemptId}.json`,
      ),
      value,
    );
  }

  async listSettlements(
    decisionId: string,
    channel: string,
  ): Promise<HumanDecisionSettlementRecord[]> {
    const safeChannel = requireSimpleId(channel, "Human decision channel");
    const directory = path.join(this.decisionDir(decisionId), "settlements", safeChannel);
    return (await readJsonDirectory(directory)) as HumanDecisionSettlementRecord[];
  }

  async cancel(
    request: HumanDecisionRequest,
    reason: HumanDecisionCancellationRecord["reason"],
  ): Promise<"created" | "adopted"> {
    validateHumanDecisionRequestIntegrity(request);
    if ((await this.readResolved(request.decisionId)) !== null) {
      throw new Error("Resolved human decision cannot be cancelled");
    }
    const filePath = path.join(this.decisionDir(request.decisionId), "cancelled.json");
    const record: HumanDecisionCancellationRecord = {
      schema: "pi-workflows.human-decision-cancellation.v1",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      cancelledAt: new Date().toISOString(),
      reason,
    };
    const resolutionPath = path.join(this.decisionDir(request.decisionId), "resolution.json");
    const resolution: HumanDecisionResolution = {
      schema: "pi-workflows.human-decision-resolution.v1",
      outcome: "cancelled",
      cancellation: record,
    };
    const result = await writeImmutableJson(resolutionPath, resolution, false);
    const winner =
      result === "created"
        ? resolution
        : ((await readJson(resolutionPath)) as HumanDecisionResolution | null);
    if (winner === null) throw new Error("Human decision resolution became unreadable");
    if (winner.outcome === "accepted") {
      throw new Error("Resolved human decision cannot be cancelled");
    }
    const existing = winner.cancellation;
    if (
      existing.decisionId !== request.decisionId ||
      existing.requestDigest !== request.requestDigest ||
      existing.reason !== reason
    ) {
      throw new Error("Immutable human decision cancellation conflicts");
    }
    await writeImmutableJson(filePath, existing);
    return result;
  }

  async readCancellation(decisionId: string): Promise<HumanDecisionCancellationRecord | null> {
    const stored = (await readJson(
      path.join(this.decisionDir(decisionId), "cancelled.json"),
    )) as HumanDecisionCancellationRecord | null;
    if (stored !== null) return stored;
    const resolution = requireCurrentResolution(
      await readJson(path.join(this.decisionDir(decisionId), "resolution.json")),
    );
    if (resolution?.outcome !== "cancelled") return null;
    await writeImmutableJson(
      path.join(this.decisionDir(decisionId), "cancelled.json"),
      resolution.cancellation,
    );
    return resolution.cancellation;
  }

  async readResolved(decisionId: string): Promise<ResolvedHumanDecision | null> {
    const cancellation = await readJson(path.join(this.decisionDir(decisionId), "cancelled.json"));
    if (cancellation !== null) return null;
    const stored = await readJson(path.join(this.decisionDir(decisionId), "accepted.json"));
    if (stored !== null) return requireCurrentDecision(stored);
    const resolution = requireCurrentResolution(
      await readJson(path.join(this.decisionDir(decisionId), "resolution.json")),
    );
    if (resolution?.outcome !== "accepted") return null;
    await writeImmutableJson(
      path.join(this.decisionDir(decisionId), "accepted.json"),
      resolution.decision,
    );
    return resolution.decision;
  }

  async recordContinuation(
    decisionId: string,
    value: HumanDecisionContinuationRecord,
  ): Promise<"created" | "adopted"> {
    return await writeImmutableJson(
      path.join(this.decisionDir(decisionId), "continuation.json"),
      value,
    );
  }

  async readContinuation(decisionId: string): Promise<HumanDecisionContinuationRecord | null> {
    return (await readJson(
      path.join(this.decisionDir(decisionId), "continuation.json"),
    )) as HumanDecisionContinuationRecord | null;
  }

  async listRequests(): Promise<HumanDecisionRequest[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const requests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => await this.readRequest(entry.name)),
    );
    return requests.filter((request): request is HumanDecisionRequest => request !== null);
  }
}

export function createHumanDecisionAttemptId(): string {
  return randomUUID();
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function digest(value: unknown): string {
  return `sha256:${digestHex(value)}`;
}

function digestHex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function validatePresentedChoices(choices: HumanDecisionChoiceMap): void {
  for (const [key, definition] of Object.entries(choices)) {
    validatePresentedText(definition.label, `Human decision choice ${key} label`);
    if (definition.input !== undefined) {
      validatePresentedText(definition.input.prompt, `Human decision choice ${key} input prompt`);
    }
  }
}

function validatePresentedText(value: string, label: string): void {
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(`${label} contains a control character`);
  }
}

function validateChoices(choices: HumanDecisionChoiceMap): void {
  const entries = Object.entries(choices);
  if (entries.length === 0) throw new Error("Human decision choices must not be empty");
  const labels = new Set<string>();
  for (const [key, definition] of entries) {
    if (!CHOICE_PATTERN.test(key)) {
      throw new Error(`Human decision choice ${JSON.stringify(key)} is invalid`);
    }
    validateChoice(definition, `Human decision choice ${key}`);
    if (labels.has(definition.label)) {
      throw new Error(
        `Human decision choice label ${JSON.stringify(definition.label)} is duplicated`,
      );
    }
    labels.add(definition.label);
  }
}

function validateChoice(value: unknown, label: string): asserts value is HumanDecisionChoice {
  const definition = requireRecord(value, label);
  requireString(definition.label, `${label} label`);
  if (definition.input !== undefined) {
    const input = requireRecord(definition.input, `${label} input`);
    if (input.kind !== "text") throw new Error(`${label} input kind must be text`);
    requireSimpleId(input.name, `${label} input name`);
    requireString(input.prompt, `${label} input prompt`);
    if (!Number.isInteger(input.minLength) || (input.minLength as number) < 0) {
      throw new Error(`${label} input minLength must be a non-negative integer`);
    }
    if (
      !Number.isInteger(input.maxLength) ||
      (input.maxLength as number) < 1 ||
      (input.maxLength as number) < (input.minLength as number)
    ) {
      throw new Error(`${label} input maxLength is invalid`);
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireChannelId(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!CHANNEL_PATTERN.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function requireSimpleId(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!CHOICE_PATTERN.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function assertJsonValue(value: unknown, label: string): void {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("undefined JSON value");
    JSON.parse(encoded);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
}

async function writeImmutableJson(
  filePath: string,
  value: unknown,
  requireIdentical = true,
): Promise<"created" | "adopted"> {
  const bytes = `${canonicalJson(value)}\n`;
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, filePath);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(filePath, "utf8");
    if (requireIdentical && existing !== bytes) {
      throw new Error(`Immutable human decision record conflicts: ${filePath}`);
    }
    return "adopted";
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function validateExpiry(
  value: string | undefined,
  createdAt: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Human decision expiry must be an ISO timestamp");
  const created = createdAt === undefined ? Date.now() : Date.parse(createdAt);
  if (!Number.isFinite(created) || parsed <= created) {
    throw new Error("Human decision expiry must be after creation");
  }
  return new Date(parsed).toISOString();
}

async function readJsonDirectory(directory: string): Promise<unknown[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const values = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(async (name) => await readJson(path.join(directory, name))),
  );
  return values.filter((value) => value !== null);
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
