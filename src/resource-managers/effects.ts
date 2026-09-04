import { jsonFingerprint } from "./json.js";
import type { ResourceManagerStore } from "./store.js";
import type {
  ResourceManagerEffects,
  ResourceManagerQueueClaim,
  ManagedResource,
  EffectApplication,
  EffectDefinition,
  EffectObservation,
  EffectRecord,
  JsonObject,
} from "./types.js";

export class ResourceManagerEffectService implements ResourceManagerEffects {
  private used = false;

  constructor(
    private readonly store: ResourceManagerStore,
    private readonly resource: ManagedResource,
    private readonly claim: ResourceManagerQueueClaim,
    private readonly signal: AbortSignal,
  ) {}

  async ensure<TRequest>(definition: EffectDefinition<TRequest>): Promise<EffectRecord> {
    if (this.used) {
      throw new Error("A reconciliation pass may ensure only one external effect");
    }
    this.used = true;
    const requestFingerprint = jsonFingerprint(definition.request);
    const reservation = this.store.reserveEffect({
      key: definition.key,
      resourceUid: this.resource.metadata.uid,
      claim: this.claim,
      generation: this.resource.metadata.generation,
      kind: definition.kind,
      requestFingerprint,
    });
    if (reservation.record.state === "applied" || reservation.record.state === "rejected") {
      return reservation.record;
    }

    if (!reservation.created) {
      const observed = await this.observe(definition);
      const recovered = this.applyObservation(definition.key, observed);
      if (recovered !== undefined) {
        return recovered;
      }
    }

    return await this.apply(definition);
  }

  private async observe<TRequest>(
    definition: EffectDefinition<TRequest>,
  ): Promise<EffectObservation> {
    try {
      return await definition.observe(this.signal);
    } catch (error) {
      this.recordEvent("effect_observe_failed", definition.key, {
        error: boundedError(error),
      });
      throw error;
    }
  }

  private applyObservation(key: string, observation: EffectObservation): EffectRecord | undefined {
    if (observation.state === "not_applied") {
      return undefined;
    }
    const record = this.store.updateEffect({
      resourceUid: this.resource.metadata.uid,
      key,
      claim: this.claim,
      state: observation.state === "applied" ? "applied" : "indeterminate",
      ...("externalRef" in observation && observation.externalRef !== undefined
        ? { externalRef: observation.externalRef }
        : {}),
    });
    this.recordEvent(
      observation.state === "applied" ? "effect_recovered" : "effect_indeterminate",
      key,
    );
    return record;
  }

  private async apply<TRequest>(definition: EffectDefinition<TRequest>): Promise<EffectRecord> {
    let result: EffectApplication;
    try {
      result = await definition.apply(this.signal);
    } catch (error) {
      const message = boundedError(error);
      const record = this.store.updateEffect({
        resourceUid: this.resource.metadata.uid,
        key: definition.key,
        claim: this.claim,
        state: "indeterminate",
        error: message,
      });
      this.recordEvent("effect_indeterminate", definition.key, { error: message });
      return record;
    }
    const record = this.store.updateEffect({
      resourceUid: this.resource.metadata.uid,
      key: definition.key,
      claim: this.claim,
      state: result.state,
      ...(result.state === "applied" && result.externalRef !== undefined
        ? { externalRef: result.externalRef }
        : {}),
      ...(result.state !== "applied" && result.error !== undefined ? { error: result.error } : {}),
    });
    this.recordEvent(`effect_${result.state}`, definition.key);
    return record;
  }

  private recordEvent(type: string, effectKey: string, extra: JsonObject = {}): void {
    this.store.recordEvent({
      resourceManager: this.resource.metadata.resourceManager,
      key: this.resource.metadata.key,
      claim: this.claim,
      type,
      payload: { effectKey, ...extra },
    });
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 8_192 ? message : `${message.slice(0, 8_192)}…`;
}
