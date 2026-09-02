import { createHash, randomUUID } from "node:crypto";
import { StateDatabase, workflowStatePath } from "../state/database.js";
import { resourceIdFor, tokenHash } from "../state/mutation.js";
import { recordViewerDeltas } from "../state/viewer.js";
import {
  digestCanonical,
  normalizeDecisionPresentation,
  validateHumanDecisionRequestIntegrity,
} from "./decision-presentation.js";
import { checkpoint } from "./definition.js";
import type { RunWriteAuthority } from "./store.js";
import type {
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

export function humanDecisionDatabasePath(homeDir?: string): string {
  return workflowStatePath(homeDir);
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

export class HumanDecisionStore {
  readonly databasePath: string;
  readonly state: StateDatabase;
  private readonly ownsState: boolean;
  private readonly authorityProvider:
    | ((runId: string) => RunWriteAuthority | undefined)
    | undefined;

  constructor(
    databasePath: string = workflowStatePath(),
    options: {
      state?: StateDatabase;
      authorityProvider?: (runId: string) => RunWriteAuthority | undefined;
      readOnly?: boolean;
    } = {},
  ) {
    this.ownsState = options.state === undefined;
    this.state =
      options.state ??
      new StateDatabase({
        filePath: databasePath,
        mode: options.readOnly === true ? "read-only" : "read-write",
        checkLegacyState: databasePath === workflowStatePath(),
      });
    this.databasePath = this.state.filePath;
    this.authorityProvider = options.authorityProvider;
  }

  close(): void {
    if (this.ownsState) this.state.close();
  }

  async createRequest(request: HumanDecisionRequest): Promise<"created" | "adopted"> {
    validateHumanDecisionRequestIntegrity(request);
    return this.state.transaction(() => {
      const existing = this.readRequestRow(request.decisionId);
      if (existing !== undefined) {
        const stored = this.readRequestFromHash(existing.requestHash);
        if (canonicalJson(stored) !== canonicalJson(request)) {
          throw new Error("Immutable human decision request conflicts");
        }
        return "adopted";
      }
      const run = this.state.connection
        .prepare("SELECT resource_id AS resourceId FROM runs WHERE run_id = ?")
        .get(request.runId);
      if (!isResourceIdRow(run)) throw new Error(`Human decision run is missing: ${request.runId}`);
      const attempt = this.state.connection
        .prepare("SELECT 1 AS present FROM node_attempts WHERE attempt_id = ? AND run_id = ?")
        .get(request.attemptId, request.runId);
      if (!isPresentRow(attempt)) {
        throw new Error(`Human decision attempt is missing: ${request.attemptId}`);
      }
      const now = Date.parse(request.createdAt);
      const resourceId = resourceIdFor("decision", request.decisionId);
      const subjectHash = this.state.putJson(request.subject, now);
      const presentationHash = this.state.putJson(request.presentation, now);
      const choicesHash = this.state.putJson(request.choices, now);
      const defaultHash =
        request.defaultResponse === undefined
          ? null
          : this.state.putJson(request.defaultResponse, now);
      const requestHash = this.state.putJson(request, now);
      this.state.connection
        .prepare(
          `INSERT INTO resources(
             resource_id, resource_type, aggregate_key, revision, created_at, updated_at
           ) VALUES (?, 'decision', ?, 1, ?, ?)`,
        )
        .run(resourceId, request.decisionId, now, now);
      this.state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(resourceId);
      this.state.connection
        .prepare(
          `INSERT INTO human_decisions(
             decision_id, resource_id, run_id, attempt_id, audience, title,
             subject_hash, presentation_hash, choices_hash, request_digest,
             presentation_revision, deadline_at, default_response_hash, request_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.decisionId,
          resourceId,
          request.runId,
          request.attemptId,
          request.audience,
          request.title,
          subjectHash,
          presentationHash,
          choicesHash,
          digestBuffer(request.requestDigest),
          request.revision,
          request.expiresAt === undefined ? null : Date.parse(request.expiresAt),
          defaultHash,
          requestHash,
          now,
        );
      this.insertDecisionEvent(
        resourceId,
        1,
        "decision.requested",
        "system",
        null,
        requestHash,
        now,
      );
      recordDecisionViewerChange(this.state, request.runId, request.decisionId, now);
      return "created";
    });
  }

  async readRequest(decisionId: string): Promise<HumanDecisionRequest | null> {
    assertId(decisionId, "decision id");
    const row = this.readRequestRow(decisionId);
    return row === undefined ? null : this.readRequestFromHash(row.requestHash);
  }

  async recordDelivery(
    request: HumanDecisionRequest | HumanDecisionChannelRequest,
    channel: string,
    value: HumanDecisionDeliveryRecord,
  ): Promise<"created" | "adopted"> {
    return this.recordDeliverySync(request, channel, value);
  }

  recordDeliverySync(
    request: HumanDecisionRequest | HumanDecisionChannelRequest,
    channel: string,
    value: HumanDecisionDeliveryRecord,
  ): "created" | "adopted" {
    return this.recordChannelMessage(request.decisionId, channel, "delivery", value);
  }

  async accept(
    request: HumanDecisionRequest,
    submission: HumanDecisionSubmission,
  ): Promise<HumanDecisionAcceptance> {
    return this.acceptSync(request, submission);
  }

  acceptSync(
    request: HumanDecisionRequest,
    submission: HumanDecisionSubmission,
  ): HumanDecisionAcceptance {
    validateHumanDecisionRequestIntegrity(request);
    const normalized = validateHumanDecisionSubmission(request, submission);
    const attemptedAt = new Date().toISOString();
    const attemptId = digestHex({
      decisionId: request.decisionId,
      idempotencyKey: normalized.idempotencyKey,
    }).slice(0, 40);
    const decision: ResolvedHumanDecision = {
      schema: "pi-workflows.human-decision-accepted.v1",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      response: validateHumanDecisionResponse(request, normalized),
      provenance: "human",
      source: normalized.source,
      idempotencyKey: normalized.idempotencyKey,
      acceptedAt: attemptedAt,
      answerDigest: digest({
        requestDigest: request.requestDigest,
        response: validateHumanDecisionResponse(request, normalized),
        source: normalized.source,
      }),
      subjectDigest: request.subjectDigest,
      presentationDigest: request.presentationDigest,
      revision: request.revision,
    };
    return this.attemptAcceptance(request, decision, {
      attemptId,
      source: "human",
      actorId: normalized.source.actorId,
      channel: normalized.source.channel,
      candidate: normalized,
    });
  }

  async resolveTimeout(
    request: HumanDecisionRequest,
    now = new Date(),
  ): Promise<HumanDecisionAcceptance> {
    return this.resolveTimeoutSync(request, now);
  }

  resolveTimeoutSync(request: HumanDecisionRequest, now = new Date()): HumanDecisionAcceptance {
    validateHumanDecisionRequestIntegrity(request);
    if (request.expiresAt === undefined || request.defaultResponse === undefined) {
      throw new Error("Human decision request has no timeout default");
    }
    if (Date.parse(request.expiresAt) > now.getTime()) {
      throw new Error("Human decision timeout default is not eligible yet");
    }
    this.assertRunOwner(request.runId, now.getTime());
    const response = validateHumanDecisionResponse(request, request.defaultResponse);
    const decision: ResolvedHumanDecision = {
      schema: "pi-workflows.human-decision-accepted.v1",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      response,
      provenance: "timeout",
      acceptedAt: now.toISOString(),
      answerDigest: digest({
        provenance: "timeout",
        requestDigest: request.requestDigest,
        response,
      }),
      subjectDigest: request.subjectDigest,
      presentationDigest: request.presentationDigest,
      revision: request.revision,
    };
    const actorId = this.authorityProvider?.(request.runId)?.ownerId;
    return this.attemptAcceptance(request, decision, {
      attemptId: digestHex({ decisionId: request.decisionId, provenance: "timeout" }).slice(0, 40),
      source: "policy",
      ...(actorId === undefined ? {} : { actorId }),
      candidate: response,
    });
  }

  async listDeliveries(
    decisionId: string,
    channel: string,
  ): Promise<HumanDecisionDeliveryRecord[]> {
    return this.listChannelMessages<HumanDecisionDeliveryRecord>(decisionId, channel, "delivery");
  }

  async recordSettlement(
    decisionId: string,
    channel: string,
    value: HumanDecisionSettlementRecord,
  ): Promise<"created" | "adopted"> {
    return this.recordSettlementSync(decisionId, channel, value);
  }

  recordSettlementSync(
    decisionId: string,
    channel: string,
    value: HumanDecisionSettlementRecord,
  ): "created" | "adopted" {
    return this.recordChannelMessage(decisionId, channel, "settlement", value);
  }

  async listSettlements(
    decisionId: string,
    channel: string,
  ): Promise<HumanDecisionSettlementRecord[]> {
    return this.listChannelMessages<HumanDecisionSettlementRecord>(
      decisionId,
      channel,
      "settlement",
    );
  }

  async cancel(
    request: HumanDecisionRequest,
    reason: HumanDecisionCancellationRecord["reason"],
  ): Promise<"created" | "adopted"> {
    validateHumanDecisionRequestIntegrity(request);
    if (reason === "expired" && request.defaultResponse !== undefined) {
      throw new Error("A defaulted human decision must resolve through its timeout policy");
    }
    return this.state.transaction(() => {
      this.requireStoredRequest(request);
      const winner = this.readResolution(request.decisionId);
      if (winner !== null) {
        if (winner.outcome === "cancelled") {
          if (winner.cancellation.reason === reason) return "adopted";
          throw new Error(
            `Human decision was already cancelled with reason ${winner.cancellation.reason}`,
          );
        }
        throw new Error(`Human decision was already accepted by ${winner.decision.provenance}`);
      }
      const now = Date.now();
      if (reason === "expired") {
        if (request.expiresAt === undefined) {
          throw new Error("Human decision request has no expiry");
        }
        if (Date.parse(request.expiresAt) > now) {
          throw new Error("Human decision expiry cancellation is not eligible yet");
        }
        this.assertRunOwner(request.runId, now);
      }
      const record: HumanDecisionCancellationRecord = {
        schema: "pi-workflows.human-decision-cancellation.v1",
        decisionId: request.decisionId,
        requestDigest: request.requestDigest,
        cancelledAt: new Date(now).toISOString(),
        reason,
      };
      const provenance = reason === "expired" ? "expired_no_default" : "explicit_cancel";
      this.state.connection
        .prepare(
          `INSERT INTO human_decision_resolutions(
             decision_id, outcome, provenance, response_hash, reason, channel,
             actor_id, request_digest, resolved_at
           ) VALUES (?, 'cancelled', ?, NULL, ?, NULL, NULL, ?, ?)`,
        )
        .run(request.decisionId, provenance, reason, digestBuffer(request.requestDigest), now);
      const row = this.requireDecisionResource(request.decisionId);
      this.bumpDecision(row.resourceId, row.revision, now);
      const recordHash = this.state.putJson(record, now);
      this.insertDecisionEvent(
        row.resourceId,
        row.revision + 1,
        "decision.cancelled",
        reason === "expired" ? "policy" : "control",
        null,
        recordHash,
        now,
      );
      this.enqueueResolutionEffects(row.resourceId, row.revision + 1, request, "cancelled", now);
      recordDecisionViewerChange(this.state, request.runId, request.decisionId, now);
      return "created";
    });
  }

  async readCancellation(decisionId: string): Promise<HumanDecisionCancellationRecord | null> {
    const resolution = this.readResolution(decisionId);
    return resolution?.outcome === "cancelled" ? resolution.cancellation : null;
  }

  async readResolved(decisionId: string): Promise<ResolvedHumanDecision | null> {
    const resolution = this.readResolution(decisionId);
    return resolution?.outcome === "accepted" ? resolution.decision : null;
  }

  async recordContinuation(
    decisionId: string,
    value: HumanDecisionContinuationRecord,
  ): Promise<"created" | "adopted"> {
    return this.state.transaction(() => {
      const existing = this.readContinuationRow(decisionId);
      if (existing !== undefined) {
        const stored = this.continuationRecord(decisionId, existing);
        if (canonicalJson(stored) !== canonicalJson(value)) {
          throw new Error("Immutable human decision continuation conflicts");
        }
        return "adopted";
      }
      const resolution = this.readResolution(decisionId);
      if (resolution?.outcome !== "accepted") {
        throw new Error("A continuation requires an accepted human decision");
      }
      this.state.connection
        .prepare(
          `INSERT INTO continuations(
             decision_id, parent_run_id, continuation_run_id, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(decisionId, value.parentRunId, value.runId, Date.parse(value.createdAt));
      return "created";
    });
  }

  async readContinuation(decisionId: string): Promise<HumanDecisionContinuationRecord | null> {
    const row = this.readContinuationRow(decisionId);
    return row === undefined ? null : this.continuationRecord(decisionId, row);
  }

  markEffectApplied(
    decisionId: string,
    effectType: "decision.continue" | "decision.cancel_parent" | "decision.settle_presentations",
  ): void {
    const rows = this.state.connection
      .prepare(
        `SELECT e.effect_id AS effectId, e.resource_id AS resourceId
         FROM effects e
         JOIN human_decisions d ON d.resource_id = e.source_resource_id
         WHERE d.decision_id = ? AND e.effect_type = ? AND e.status = 'pending'`,
      )
      .all(decisionId, effectType);
    for (const row of rows) {
      /* istanbul ignore if -- exact schema and internal query shape */
      if (!isEffectIdentityRecord(row)) continue;
      this.state.transaction(() => {
        const now = Date.now();
        const revisionRow = this.state.connection
          .prepare("SELECT revision FROM resources WHERE resource_id = ?")
          .get(row.resourceId);
        /* istanbul ignore if -- exact schema and internal query shape */
        if (!isRevisionRecord(revisionRow)) throw new Error("Decision effect resource is missing");
        this.state.connection
          .prepare(
            `UPDATE effects SET status = 'applied', updated_at = ?, settled_at = ?
             WHERE effect_id = ? AND status = 'pending'`,
          )
          .run(now, now, row.effectId);
        this.state.connection
          .prepare(
            `UPDATE resources SET revision = revision + 1, updated_at = ?
             WHERE resource_id = ? AND revision = ?`,
          )
          .run(now, row.resourceId, revisionRow.revision);
        const payloadHash = this.state.putJson({ decisionId, effectType }, now);
        this.insertDecisionEvent(
          row.resourceId,
          revisionRow.revision + 1,
          "effect.applied",
          "system",
          null,
          payloadHash,
          now,
        );
      });
    }
  }

  async listRequests(): Promise<HumanDecisionRequest[]> {
    const rows = this.state.connection
      .prepare("SELECT request_hash AS requestHash FROM human_decisions ORDER BY created_at")
      .all();
    return rows.filter(isRequestHashRow).map((row) => this.readRequestFromHash(row.requestHash));
  }

  async listExpiredDefaultRequests(now = new Date()): Promise<HumanDecisionRequest[]> {
    const timestamp = now.getTime();
    if (!Number.isFinite(timestamp)) throw new Error("Human decision timeout date is invalid");
    const rows = this.state.connection
      .prepare(
        `SELECT h.request_hash AS requestHash
         FROM human_decisions h
         LEFT JOIN human_decision_resolutions r ON r.decision_id = h.decision_id
         WHERE h.deadline_at IS NOT NULL AND h.deadline_at <= ?
           AND h.default_response_hash IS NOT NULL AND r.decision_id IS NULL
         ORDER BY h.deadline_at, h.decision_id`,
      )
      .all(timestamp);
    return rows.filter(isRequestHashRow).map((row) => this.readRequestFromHash(row.requestHash));
  }

  private attemptAcceptance(
    request: HumanDecisionRequest,
    decision: ResolvedHumanDecision,
    attempt: {
      attemptId: string;
      source: "human" | "policy";
      actorId?: string;
      channel?: string;
      candidate: unknown;
    },
  ): HumanDecisionAcceptance {
    return this.state.transaction(() => {
      this.requireStoredRequest(request);
      const timing = this.state.connection
        .prepare("SELECT deadline_at AS deadlineAt FROM human_decisions WHERE decision_id = ?")
        .get(request.decisionId);
      if (!isDeadlineRow(timing)) throw new Error("Human decision request is missing");
      const arbitrationTime =
        attempt.source === "policy" ? Date.parse(decision.acceptedAt) : Date.now();
      if (
        attempt.source === "human" &&
        timing.deadlineAt !== null &&
        arbitrationTime > timing.deadlineAt
      ) {
        throw new Error("Human decision request expired before the answer was accepted");
      }
      if (
        attempt.source === "policy" &&
        (timing.deadlineAt === null || arbitrationTime < timing.deadlineAt)
      ) {
        throw new Error("Human decision timeout default is not eligible yet");
      }
      if (attempt.source === "policy") this.assertRunOwner(request.runId, arbitrationTime);
      const candidateHash = this.state.putJson(attempt.candidate);
      const existingSubmission = this.state.connection
        .prepare(
          `SELECT candidate_hash AS candidateHash
           FROM human_decision_submissions WHERE decision_id = ? AND attempt_id = ?`,
        )
        .get(request.decisionId, attempt.attemptId);
      if (
        isCandidateHashRow(existingSubmission) &&
        !existingSubmission.candidateHash.equals(candidateHash)
      ) {
        throw new Error("Human decision submission idempotency key conflicts");
      }
      this.state.connection
        .prepare(
          `INSERT INTO human_decision_submissions(
             decision_id, attempt_id, source, actor_id, channel,
             candidate_hash, outcome, submitted_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?)
           ON CONFLICT(decision_id, attempt_id) DO NOTHING`,
        )
        .run(
          request.decisionId,
          attempt.attemptId,
          attempt.source,
          attempt.actorId ?? null,
          attempt.channel ?? null,
          candidateHash,
          Date.parse(decision.acceptedAt),
        );
      const winner = this.readResolution(request.decisionId);
      if (winner !== null) {
        this.markSubmission(request.decisionId, attempt.attemptId, "already_resolved", null);
        if (winner.outcome === "cancelled") {
          throw new Error(`Human decision request was ${winner.cancellation.reason}`);
        }
        return canonicalJson(winner.decision) === canonicalJson(decision) ||
          sameHumanAnswer(winner.decision, decision)
          ? { status: "adopted", decision: winner.decision }
          : { status: "conflict", decision: winner.decision };
      }
      const now = Date.parse(decision.acceptedAt);
      const responseHash = this.state.putJson(decision, now);
      this.state.connection
        .prepare(
          `INSERT INTO human_decision_resolutions(
             decision_id, outcome, provenance, response_hash, reason, channel,
             actor_id, request_digest, resolved_at
           ) VALUES (?, 'accepted', ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          request.decisionId,
          decision.provenance === "timeout" ? "timeout_policy" : "human",
          responseHash,
          attempt.channel ?? null,
          attempt.actorId ?? null,
          digestBuffer(request.requestDigest),
          now,
        );
      const row = this.requireDecisionResource(request.decisionId);
      this.bumpDecision(row.resourceId, row.revision, now);
      this.insertDecisionEvent(
        row.resourceId,
        row.revision + 1,
        "decision.accepted",
        decision.provenance === "timeout" ? "policy" : "human",
        attempt.actorId ?? null,
        responseHash,
        now,
      );
      this.enqueueResolutionEffects(row.resourceId, row.revision + 1, request, "accepted", now);
      this.markSubmission(request.decisionId, attempt.attemptId, "won", responseHash);
      recordDecisionViewerChange(this.state, request.runId, request.decisionId, now);
      return { status: "accepted", decision };
    });
  }

  private readResolution(decisionId: string): HumanDecisionResolution | null {
    const row = this.state.connection
      .prepare(
        `SELECT outcome, provenance, response_hash AS responseHash, reason,
                request_digest AS requestDigest, resolved_at AS resolvedAt
         FROM human_decision_resolutions WHERE decision_id = ?`,
      )
      .get(decisionId);
    if (!isResolutionRow(row)) return null;
    const request = this.readRequestRow(decisionId);
    if (request === undefined) throw new Error("Human decision request is missing");
    const storedRequest = this.readRequestFromHash(request.requestHash);
    if (!row.requestDigest.equals(digestBuffer(storedRequest.requestDigest))) {
      throw new Error("Human decision resolution request digest conflicts");
    }
    if (row.outcome === "accepted") {
      if (row.responseHash === null) throw new Error("Accepted decision response is missing");
      const decision = this.state.readJson(row.responseHash) as ResolvedHumanDecision;
      return {
        schema: "pi-workflows.human-decision-resolution.v1",
        outcome: "accepted",
        decision: requireCurrentDecision(decision),
      };
    }
    const cancellation: HumanDecisionCancellationRecord = {
      schema: "pi-workflows.human-decision-cancellation.v1",
      decisionId,
      requestDigest: storedRequest.requestDigest,
      cancelledAt: new Date(row.resolvedAt).toISOString(),
      reason: row.reason === "expired" ? "expired" : "cancelled",
    };
    return {
      schema: "pi-workflows.human-decision-resolution.v1",
      outcome: "cancelled",
      cancellation,
    };
  }

  private requireStoredRequest(request: HumanDecisionRequest): void {
    const row = this.readRequestRow(request.decisionId);
    if (row === undefined) throw new Error("Human decision request is not durable");
    const stored = this.readRequestFromHash(row.requestHash);
    if (canonicalJson(stored) !== canonicalJson(request)) {
      throw new Error("Human decision request does not match durable state");
    }
  }

  private readRequestRow(decisionId: string): { requestHash: Buffer } | undefined {
    const row = this.state.connection
      .prepare("SELECT request_hash AS requestHash FROM human_decisions WHERE decision_id = ?")
      .get(decisionId);
    return isRequestHashRow(row) ? row : undefined;
  }

  private readRequestFromHash(hash: Buffer): HumanDecisionRequest {
    return validateHumanDecisionRequestIntegrity(this.state.readJson(hash) as HumanDecisionRequest);
  }

  private requireDecisionResource(decisionId: string): { resourceId: string; revision: number } {
    const row = this.state.connection
      .prepare(
        `SELECT d.resource_id AS resourceId, r.revision
         FROM human_decisions d JOIN resources r ON r.resource_id = d.resource_id
         WHERE d.decision_id = ?`,
      )
      .get(decisionId);
    if (!isDecisionResourceRow(row)) throw new Error(`Human decision is missing: ${decisionId}`);
    return row;
  }

  private bumpDecision(resourceId: string, expectedRevision: number, now: number): void {
    const result = this.state.connection
      .prepare(
        `UPDATE resources SET revision = revision + 1, updated_at = ?
         WHERE resource_id = ? AND revision = ?`,
      )
      .run(now, resourceId, expectedRevision);
    if (result.changes !== 1) throw new Error("Human decision revision conflict");
  }

  private insertDecisionEvent(
    resourceId: string,
    revision: number,
    eventType: string,
    actorType: string,
    actorId: string | null,
    payloadHash: Buffer,
    now: number,
  ): void {
    this.state.connection
      .prepare(
        `INSERT INTO events(
           event_id, resource_id, resource_revision, event_type,
           actor_type, actor_id, payload_hash, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `event-${randomUUID()}`,
        resourceId,
        revision,
        eventType,
        actorType,
        actorId,
        payloadHash,
        now,
      );
  }

  private enqueueResolutionEffects(
    decisionResourceId: string,
    revision: number,
    request: HumanDecisionRequest,
    outcome: "accepted" | "cancelled",
    now: number,
  ): void {
    const types =
      outcome === "accepted"
        ? ["decision.continue", "decision.settle_presentations"]
        : ["decision.cancel_parent", "decision.settle_presentations"];
    for (const effectType of types) {
      const idempotencyKey = request.decisionId;
      const effectId = `effect-${digestHex({ decisionId: request.decisionId, effectType }).slice(0, 40)}`;
      const effectResourceId = resourceIdFor("effect", effectId);
      const payloadHash = this.state.putJson(
        { decisionId: request.decisionId, runId: request.runId, outcome },
        now,
      );
      this.state.connection
        .prepare(
          `INSERT INTO resources(
             resource_id, resource_type, aggregate_key, revision, created_at, updated_at
           ) VALUES (?, 'effect', ?, 0, ?, ?)`,
        )
        .run(effectResourceId, effectId, now, now);
      this.state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(effectResourceId);
      this.state.connection
        .prepare(
          `INSERT INTO effects(
             effect_id, resource_id, source_resource_id, source_revision,
             effect_type, idempotency_key, payload_hash, owner_scope,
             status, attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'run', 'pending', 0, ?, ?)`,
        )
        .run(
          effectId,
          effectResourceId,
          decisionResourceId,
          revision,
          effectType,
          idempotencyKey,
          payloadHash,
          now,
          now,
        );
    }
  }

  private assertRunOwner(runId: string, now: number): void {
    const authority = this.authorityProvider?.(runId);
    if (authority === undefined) {
      throw new Error("Timeout policy requires the current run owner");
    }
    const row = this.state.connection
      .prepare(
        `SELECT l.generation, l.owner_type AS ownerType, l.owner_id AS ownerId,
                l.token_hash AS tokenHash, l.expires_at AS expiresAt
         FROM runs r JOIN leases l ON l.resource_id = r.resource_id
         WHERE r.run_id = ?`,
      )
      .get(runId);
    if (
      !isOwnerRow(row) ||
      row.ownerType !== authority.ownerType ||
      row.ownerId !== authority.ownerId ||
      row.generation !== authority.generation ||
      row.tokenHash === null ||
      !row.tokenHash.equals(tokenHash(authority.token)) ||
      row.expiresAt === null ||
      row.expiresAt <= now
    ) {
      throw new Error("Timeout policy run ownership is stale");
    }
  }

  private recordChannelMessage<
    T extends HumanDecisionDeliveryRecord | HumanDecisionSettlementRecord,
  >(
    decisionId: string,
    channel: string,
    purpose: "delivery" | "settlement",
    value: T,
  ): "created" | "adopted" {
    const safeChannel = requireChannelId(channel, "Human decision channel");
    assertId(value.attemptId, `${purpose} attempt id`);
    return this.state.transaction(() => {
      if (this.readRequestRow(decisionId) === undefined) {
        throw new Error(`Human decision is missing: ${decisionId}`);
      }
      const channelId = this.ensureChannel(safeChannel, Date.parse(value.createdAt));
      const messageId = `message-${digestHex({
        decisionId,
        channel: safeChannel,
        purpose,
        attemptId: value.attemptId,
        phase: "phase" in value ? value.phase : undefined,
        partIndex: "partIndex" in value ? value.partIndex : undefined,
      }).slice(0, 40)}`;
      const contentHash = this.state.putJson(value, Date.parse(value.createdAt));
      const existing = this.state.connection
        .prepare("SELECT content_hash AS contentHash FROM channel_messages WHERE message_id = ?")
        .get(messageId);
      if (isContentHashRow(existing)) {
        if (!existing.contentHash.equals(contentHash)) {
          throw new Error(`Immutable human decision ${purpose} conflicts`);
        }
        return "adopted";
      }
      const status = channelMessageStatus(value);
      this.state.connection
        .prepare(
          `INSERT INTO channel_messages(
             message_id, channel_id, decision_id, purpose, content_hash,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          channelId,
          decisionId,
          purpose,
          contentHash,
          status,
          Date.parse(value.createdAt),
          "finishedAt" in value && value.finishedAt !== undefined
            ? Date.parse(value.finishedAt)
            : Date.parse(value.createdAt),
        );
      return "created";
    });
  }

  private listChannelMessages<T>(
    decisionId: string,
    channel: string,
    purpose: "delivery" | "settlement",
  ): T[] {
    const channelId = channelIdFor(requireChannelId(channel, "Human decision channel"));
    const rows = this.state.connection
      .prepare(
        `SELECT content_hash AS contentHash
         FROM channel_messages
         WHERE decision_id = ? AND channel_id = ? AND purpose = ?
         ORDER BY created_at, message_id`,
      )
      .all(decisionId, channelId, purpose);
    return rows.filter(isContentHashRow).map((row) => this.state.readJson(row.contentHash) as T);
  }

  private ensureChannel(channel: string, now: number): string {
    const channelId = channelIdFor(channel);
    const resourceId = resourceIdFor("channel", channelId);
    this.state.connection
      .prepare(
        `INSERT INTO resources(
           resource_id, resource_type, aggregate_key, revision, created_at, updated_at
         ) VALUES (?, 'channel', ?, 1, ?, ?)
         ON CONFLICT(resource_type, aggregate_key) DO NOTHING`,
      )
      .run(resourceId, channelId, now, now);
    this.state.connection
      .prepare(
        `INSERT INTO leases(resource_id, generation)
         VALUES (?, 0) ON CONFLICT(resource_id) DO NOTHING`,
      )
      .run(resourceId);
    this.state.connection
      .prepare(
        `INSERT INTO channels(channel_id, resource_id, adapter_type, profile_key, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO NOTHING`,
      )
      .run(channelId, resourceId, channel.split("-")[0] ?? channel, channel, now);
    return channelId;
  }

  private markSubmission(
    decisionId: string,
    attemptId: string,
    outcome: "won" | "adopted" | "already_resolved" | "rejected",
    resultHash: Buffer | null,
  ): void {
    this.state.connection
      .prepare(
        `UPDATE human_decision_submissions SET outcome = ?, result_hash = ?
         WHERE decision_id = ? AND attempt_id = ?`,
      )
      .run(outcome, resultHash, decisionId, attemptId);
  }

  private readContinuationRow(decisionId: string): ContinuationRow | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT c.parent_run_id AS parentRunId, c.continuation_run_id AS continuationRunId,
                c.created_at AS createdAt, d.request_hash AS requestHash,
                r.response_hash AS resolutionHash
         FROM continuations c
         JOIN human_decisions d ON d.decision_id = c.decision_id
         JOIN human_decision_resolutions r ON r.decision_id = c.decision_id
         WHERE c.decision_id = ? AND r.outcome = 'accepted'`,
      )
      .get(decisionId);
    return isContinuationRow(row) ? row : undefined;
  }

  private continuationRecord(
    decisionId: string,
    row: ContinuationRow,
  ): HumanDecisionContinuationRecord {
    const request = this.state.readJson(row.requestHash) as HumanDecisionRequest;
    const decision = this.state.readJson(row.resolutionHash) as ResolvedHumanDecision;
    return {
      schema: "pi-workflows.human-decision-continuation.v1",
      decisionId,
      requestDigest: request.requestDigest,
      provenance: decision.provenance,
      parentRunId: row.parentRunId,
      runId: row.continuationRunId,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}

function recordDecisionViewerChange(
  state: StateDatabase,
  runId: string,
  decisionId: string,
  now: number,
): void {
  recordViewerDeltas(
    state,
    runId,
    [
      { targetType: "graph" },
      { targetType: "replay" },
      { targetType: "inspector", targetKey: `decision:${decisionId}` },
    ],
    now,
  );
}

function digestBuffer(value: string): Buffer {
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error("Expected a SHA-256 digest");
  return Buffer.from(hex, "hex");
}

function channelIdFor(channel: string): string {
  return `channel-${digestHex(channel).slice(0, 40)}`;
}

function sameHumanAnswer(left: ResolvedHumanDecision, right: ResolvedHumanDecision): boolean {
  return (
    left.provenance === "human" &&
    right.provenance === "human" &&
    left.idempotencyKey === right.idempotencyKey &&
    canonicalJson(left.response) === canonicalJson(right.response) &&
    canonicalJson(left.source) === canonicalJson(right.source)
  );
}

function channelMessageStatus(
  value: HumanDecisionDeliveryRecord | HumanDecisionSettlementRecord,
): "pending" | "confirmed" | "failed" | "ambiguous" {
  if (value.state === "confirmed") return "confirmed";
  if (value.state === "failed") return "failed";
  if (value.state === "unknown") return "ambiguous";
  return "pending";
}

type ResolutionRow = {
  outcome: "accepted" | "cancelled";
  provenance: string;
  responseHash: Buffer | null;
  reason: string | null;
  requestDigest: Buffer;
  resolvedAt: number;
};

function isResourceIdRow(value: unknown): value is { resourceId: string } {
  return isRecordValue(value);
}

function isPresentRow(value: unknown): value is { present: number } {
  return isRecordValue(value);
}

function isRequestHashRow(value: unknown): value is { requestHash: Buffer } {
  return isRecordValue(value);
}

function isDeadlineRow(value: unknown): value is { deadlineAt: number | null } {
  return isRecordValue(value);
}

function isCandidateHashRow(value: unknown): value is { candidateHash: Buffer } {
  return isRecordValue(value);
}

function isContentHashRow(value: unknown): value is { contentHash: Buffer } {
  return isRecordValue(value);
}

type ContinuationRow = {
  parentRunId: string;
  continuationRunId: string;
  createdAt: number;
  requestHash: Buffer;
  resolutionHash: Buffer;
};

function isContinuationRow(value: unknown): value is ContinuationRow {
  return isRecordValue(value);
}

function isDecisionResourceRow(value: unknown): value is { resourceId: string; revision: number } {
  return isRecordValue(value);
}

function isResolutionRow(value: unknown): value is ResolutionRow {
  return isRecordValue(value);
}

function isEffectIdentityRecord(value: unknown): value is { effectId: string; resourceId: string } {
  return isRecordValue(value);
}

function isRevisionRecord(value: unknown): value is { revision: number } {
  return isRecordValue(value);
}

function isOwnerRow(value: unknown): value is {
  generation: number;
  ownerType: string | null;
  ownerId: string | null;
  tokenHash: Buffer | null;
  expiresAt: number | null;
} {
  return isRecordValue(value);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
