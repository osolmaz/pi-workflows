import { createHash } from "node:crypto";
import type {
  DecisionPresentation,
  DecisionPresentationBlock,
  HumanDecisionChannelRequest,
  HumanDecisionRequest,
} from "./types.js";

export const MAX_PRESENTATION_CODE_UNITS = 64_000;
export const MAX_PRESENTATION_BLOCKS = 256;
export const MAX_PRESENTATION_ITEMS = 256;
export const MAX_PRESENTATION_STRING_CODE_UNITS = 16_000;
export const MAX_PRESENTATION_TRANSPORT_PARTS = 20;

export type DecisionDocumentSegment = {
  kind: "title" | "summary" | DecisionPresentationBlock["kind"] | "choices";
  text: string;
};

export function normalizeDecisionPresentation(value: unknown): DecisionPresentation {
  const presentation = requireRecord(value, "Decision presentation");
  requireExactKeys(presentation, ["schema", "summary", "blocks"], "Decision presentation");
  if (presentation.schema !== "pi-workflows.decision-presentation.v1") {
    throw new Error("Decision presentation schema must be pi-workflows.decision-presentation.v1");
  }
  const summary = normalizeDisplayString(presentation.summary, "Decision presentation summary");
  if (!Array.isArray(presentation.blocks)) {
    throw new Error("Decision presentation blocks must be an array");
  }
  if (presentation.blocks.length > MAX_PRESENTATION_BLOCKS) {
    throw new Error(
      `Decision presentation has ${presentation.blocks.length} blocks; limit is ${MAX_PRESENTATION_BLOCKS}`,
    );
  }
  const blocks = presentation.blocks.map((block, index) =>
    normalizeBlock(block, `Decision presentation block ${index + 1}`),
  );
  const normalized: DecisionPresentation = {
    schema: "pi-workflows.decision-presentation.v1",
    summary,
    blocks,
  };
  const codeUnits = presentationCodeUnits(normalized);
  if (codeUnits > MAX_PRESENTATION_CODE_UNITS) {
    throw new Error(
      `Decision presentation has ${codeUnits} UTF-16 code units; limit is ${MAX_PRESENTATION_CODE_UNITS}`,
    );
  }
  return normalized;
}

export function decisionPresentationDigest(presentation: DecisionPresentation): string {
  return digestCanonical(normalizeDecisionPresentation(presentation));
}

export function validateHumanDecisionRequestIntegrity(
  request: HumanDecisionRequest,
): HumanDecisionRequest {
  if (request.schema === "pi-workflows.human-decision-request.v1") return request;
  const presentation = normalizeDecisionPresentation(request.presentation);
  const subjectDigest = digestCanonical(request.subject);
  const presentationDigest = digestCanonical(presentation);
  const requestDigest = digestCanonical({
    schema: request.schema,
    runId: request.runId,
    workflowName: request.workflowName,
    nodeId: request.nodeId,
    attemptId: request.attemptId,
    audience: request.audience,
    title: request.title,
    choices: request.choices,
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    subject: request.subject,
    presentation,
    revision: request.revision,
  });
  if (subjectDigest !== request.subjectDigest) {
    throw new Error("Human decision subject digest does not match its durable request");
  }
  if (presentationDigest !== request.presentationDigest) {
    throw new Error("Human decision presentation digest does not match its durable request");
  }
  if (requestDigest !== request.requestDigest) {
    throw new Error("Human decision request digest does not match its durable request");
  }
  return request;
}

export function humanDecisionChannelRequest(
  request: HumanDecisionRequest,
): HumanDecisionChannelRequest {
  validateHumanDecisionRequestIntegrity(request);
  const presentation =
    request.schema === "pi-workflows.human-decision-request.v2"
      ? normalizeDecisionPresentation(request.presentation)
      : legacyDecisionPresentation(request.body);
  const presentationDigest = decisionPresentationDigest(presentation);
  return {
    schema: "pi-workflows.human-decision-channel-request.v1",
    sourceSchema: request.schema,
    decisionId: request.decisionId,
    requestDigest: request.requestDigest,
    runId: request.runId,
    workflowName: request.workflowName,
    nodeId: request.nodeId,
    attemptId: request.attemptId,
    audience: request.audience,
    title: request.title,
    presentation,
    presentationDigest,
    revision: request.schema === "pi-workflows.human-decision-request.v2" ? request.revision : 1,
    choices: request.choices,
    createdAt: request.createdAt,
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
  };
}

export function legacyDecisionPresentation(body: unknown): DecisionPresentation {
  const blocks: DecisionPresentationBlock[] = [];
  if (typeof body === "string") {
    appendLegacyText(blocks, body, "Decision details");
  } else {
    appendLegacyValue(blocks, body, undefined);
  }
  return normalizeDecisionPresentation({
    schema: "pi-workflows.decision-presentation.v1",
    summary:
      typeof body === "string"
        ? "Review the decision message below."
        : "Review the decision details below.",
    blocks,
  });
}

export function decisionDocumentSegments(
  request: HumanDecisionChannelRequest,
): DecisionDocumentSegment[] {
  const segments: DecisionDocumentSegment[] = [
    { kind: "title", text: request.title },
    { kind: "summary", text: request.presentation.summary },
  ];
  for (const block of request.presentation.blocks) {
    if (block.kind === "paragraph") segments.push({ kind: block.kind, text: block.text });
    else if (block.kind === "section") segments.push({ kind: block.kind, text: block.title });
    else if (block.kind === "bullets") {
      segments.push({ kind: block.kind, text: block.items.map((item) => `• ${item}`).join("\n") });
    } else if (block.kind === "fields") {
      segments.push({
        kind: block.kind,
        text: block.items.map(({ label, value }) => `${label}: ${value}`).join("\n"),
      });
    } else {
      segments.push({ kind: block.kind, text: block.text });
    }
  }
  const choices = Object.values(request.choices).map((choice) =>
    choice.input === undefined
      ? `• ${choice.label}`
      : `• ${choice.label}\n  ${choice.input.prompt}`,
  );
  segments.push({ kind: "choices", text: `Choices\n${choices.join("\n")}` });
  return segments;
}

export function decisionPresentationFingerprint(request: HumanDecisionChannelRequest): string {
  return request.presentationDigest.slice("sha256:".length, "sha256:".length + 12);
}

export function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${canonicalJson(value)}\n`)
    .digest("hex")}`;
}

function normalizeBlock(value: unknown, label: string): DecisionPresentationBlock {
  const block = requireRecord(value, label);
  if (block.kind === "paragraph") {
    requireExactKeys(block, ["kind", "text"], label);
    return { kind: "paragraph", text: normalizeMultilineString(block.text, `${label} text`) };
  }
  if (block.kind === "section") {
    requireExactKeys(block, ["kind", "title"], label);
    return { kind: "section", title: normalizeDisplayString(block.title, `${label} title`) };
  }
  if (block.kind === "bullets") {
    requireExactKeys(block, ["kind", "items"], label);
    return {
      kind: "bullets",
      items: normalizeItems(block.items, `${label} items`, (item, itemLabel) =>
        normalizeDisplayString(item, itemLabel),
      ),
    };
  }
  if (block.kind === "fields") {
    requireExactKeys(block, ["kind", "items"], label);
    return {
      kind: "fields",
      items: normalizeItems(block.items, `${label} items`, (item, itemLabel) => {
        const field = requireRecord(item, itemLabel);
        requireExactKeys(field, ["label", "value"], itemLabel);
        return {
          label: normalizeDisplayString(field.label, `${itemLabel} label`),
          value: normalizeDisplayString(field.value, `${itemLabel} value`),
        };
      }),
    };
  }
  if (block.kind === "preformatted") {
    requireExactKeys(block, ["kind", "text"], label);
    return { kind: "preformatted", text: normalizeMultilineString(block.text, `${label} text`) };
  }
  throw new Error(`${label} kind is not supported`);
}

function normalizeItems<T>(
  value: unknown,
  label: string,
  normalize: (item: unknown, label: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  if (value.length > MAX_PRESENTATION_ITEMS) {
    throw new Error(`${label} has ${value.length} items; limit is ${MAX_PRESENTATION_ITEMS}`);
  }
  return value.map((item, index) => normalize(item, `${label} item ${index + 1}`));
}

function normalizeDisplayString(value: unknown, label: string): string {
  const text = normalizeString(value, label);
  if (hasControlCharacter(text, false)) {
    throw new Error(`${label} contains a control character`);
  }
  return text;
}

function normalizeMultilineString(value: unknown, label: string): string {
  const text = normalizeString(value, label);
  if (hasControlCharacter(text, true)) {
    throw new Error(`${label} contains a terminal control character`);
  }
  return text;
}

function normalizeString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const text = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC");
  if (text.trim().length === 0) throw new Error(`${label} must not be empty`);
  if (text.length > MAX_PRESENTATION_STRING_CODE_UNITS) {
    throw new Error(
      `${label} has ${text.length} UTF-16 code units; limit is ${MAX_PRESENTATION_STRING_CODE_UNITS}`,
    );
  }
  return text;
}

function presentationCodeUnits(presentation: DecisionPresentation): number {
  let total = presentation.summary.length;
  for (const block of presentation.blocks) {
    if (block.kind === "paragraph" || block.kind === "preformatted") total += block.text.length;
    else if (block.kind === "section") total += block.title.length;
    else if (block.kind === "bullets") {
      total += block.items.reduce((sum, item) => sum + item.length, 0);
    } else {
      total += block.items.reduce((sum, item) => sum + item.label.length + item.value.length, 0);
    }
  }
  return total;
}

function appendLegacyValue(
  blocks: DecisionPresentationBlock[],
  value: unknown,
  label: string | undefined,
): void {
  if (isScalar(value)) {
    const scalar = legacyScalar(value);
    if (label === undefined || scalar.length > MAX_PRESENTATION_STRING_CODE_UNITS) {
      appendLegacyText(
        blocks,
        scalar,
        label === undefined ? "Decision details" : legacyLabel(label),
      );
    } else {
      blocks.push({ kind: "fields", items: [{ label: legacyLabel(label), value: scalar }] });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (label !== undefined) blocks.push({ kind: "section", title: legacyLabel(label) });
    if (value.length === 0) {
      blocks.push({ kind: "paragraph", text: "None" });
      return;
    }
    if (
      value.every(isScalar) &&
      value.every((item) => legacyScalar(item).length <= MAX_PRESENTATION_STRING_CODE_UNITS)
    ) {
      const items = value.map(legacyScalar);
      for (let index = 0; index < items.length; index += MAX_PRESENTATION_ITEMS) {
        blocks.push({ kind: "bullets", items: items.slice(index, index + MAX_PRESENTATION_ITEMS) });
      }
      return;
    }
    value.forEach((item, index) => appendLegacyValue(blocks, item, `Item ${index + 1}`));
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    compareKeys(left, right),
  );
  if (label !== undefined) blocks.push({ kind: "section", title: legacyLabel(label) });
  if (entries.length === 0) {
    blocks.push({ kind: "paragraph", text: "None" });
    return;
  }
  const fields = entries
    .filter(
      ([, child]) =>
        isScalar(child) && legacyScalar(child).length <= MAX_PRESENTATION_STRING_CODE_UNITS,
    )
    .map(([key, child]) => ({ label: legacyLabel(key), value: legacyScalar(child) }));
  for (let index = 0; index < fields.length; index += MAX_PRESENTATION_ITEMS) {
    blocks.push({ kind: "fields", items: fields.slice(index, index + MAX_PRESENTATION_ITEMS) });
  }
  for (const [key, child] of entries.filter(
    ([, child]) =>
      !isScalar(child) || legacyScalar(child).length > MAX_PRESENTATION_STRING_CODE_UNITS,
  )) {
    appendLegacyValue(blocks, child, key);
  }
}

function appendLegacyText(
  blocks: DecisionPresentationBlock[],
  value: string,
  section: string,
): void {
  const text = sanitizeLegacyText(value);
  blocks.push({ kind: "section", title: section });
  for (const part of splitByCodeUnits(text, MAX_PRESENTATION_STRING_CODE_UNITS)) {
    blocks.push({ kind: "paragraph", text: part.trim().length === 0 ? "None" : part });
  }
}

function legacyLabel(value: string): string {
  const sanitized = sanitizeLegacyText(value)
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) return "Value";
  return `${sanitized[0]!.toUpperCase()}${sanitized.slice(1)}`;
}

function legacyScalar(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return sanitizeLegacyText(String(value));
}

function sanitizeLegacyText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .normalize("NFC")
    .split("")
    .map((character) => (isControlCode(character.charCodeAt(0), true) ? "�" : character))
    .join("");
}

function hasControlCharacter(value: string, allowLineAndTab: boolean): boolean {
  return [...value].some((character) =>
    isControlCode(character.codePointAt(0) ?? 0, allowLineAndTab),
  );
}

function isControlCode(code: number, allowLineAndTab: boolean): boolean {
  if (allowLineAndTab && (code === 9 || code === 10)) return false;
  return code <= 31 || code === 127;
}

function splitByCodeUnits(value: string, limit: number): string[] {
  if (value.length <= limit) return [value];
  const parts: string[] = [];
  let remaining = value;
  while (remaining.length > 0) {
    let end = Math.min(limit, remaining.length);
    const last = remaining.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff && end < remaining.length) end -= 1;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return parts;
}

function isScalar(value: unknown): value is null | string | number | boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const extras = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`${label} is missing ${missing.join(", ")}`);
  if (extras.length > 0) throw new Error(`${label} has unknown field ${extras.join(", ")}`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
