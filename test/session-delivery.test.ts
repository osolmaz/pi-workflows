import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionDeliveryCoordinator,
  type ClaimedSessionDelivery,
} from "../src/extension/session-delivery.js";

afterEach(() => {
  vi.useRealTimers();
});

function context(
  branch: Record<string, unknown>[],
  idle: () => boolean,
  options: { pending?: () => boolean; notify?: (message: string, level?: string) => void } = {},
) {
  return {
    isIdle: idle,
    hasPendingMessages: options.pending ?? (() => false),
    sessionManager: { getBranch: () => branch },
    ui: { notify: options.notify ?? (() => {}) },
  } as never;
}

describe("SessionDeliveryCoordinator", () => {
  it("waits through a poll interval and claim lease while Pi is busy", async () => {
    vi.useFakeTimers();
    const branch: Record<string, unknown>[] = [];
    let idle = false;
    const send = vi.fn();
    const settle = vi.fn(async () => {});
    const delivery: ClaimedSessionDelivery = {
      deliveryId: "interaction:one",
      findSessionEntryId: (entries) =>
        (
          entries.find((entry) => (entry as { id?: string }).id === "entry-one") as
            | { id?: string }
            | undefined
        )?.id,
      send,
      settle,
    };
    const claim = vi.fn(async () => delivery);
    const coordinator = new SessionDeliveryCoordinator();
    const ctx = context(branch, () => idle);

    await coordinator.synchronize(ctx, [claim]);
    await vi.advanceTimersByTimeAsync(11_000);
    await coordinator.synchronize(ctx, [claim]);
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    idle = true;
    await coordinator.synchronize(ctx, [claim]);
    await coordinator.synchronize(ctx, [claim]);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();

    branch.push({ id: "entry-one" });
    await coordinator.synchronize(ctx, [claim]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith("entry-one");
  });

  it("does not claim while another Pi message is pending", async () => {
    const claim = vi.fn(async () => undefined);
    const coordinator = new SessionDeliveryCoordinator();

    await coordinator.synchronize(
      context([], () => true, { pending: () => true }),
      [claim],
    );

    expect(claim).not.toHaveBeenCalled();
  });

  it("reports an unproved send once without retrying it", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const notify = vi.fn();
    const claim = vi.fn(
      async (): Promise<ClaimedSessionDelivery> => ({
        deliveryId: "interaction:ambiguous",
        findSessionEntryId: () => undefined,
        send,
        settle: async () => {},
      }),
    );
    const coordinator = new SessionDeliveryCoordinator();
    const ctx = context([], () => true, { notify });

    await coordinator.synchronize(ctx, [claim]);
    await vi.advanceTimersByTimeAsync(10_001);
    await coordinator.synchronize(ctx, [claim]);
    await coordinator.synchronize(ctx, [claim]);

    expect(claim).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("ambiguous"), "warning");
  });

  it("adopts an existing session entry without sending it again", async () => {
    const branch = [{ id: "entry-existing" }];
    const send = vi.fn();
    const settle = vi.fn(async () => {});
    const coordinator = new SessionDeliveryCoordinator();

    await coordinator.synchronize(
      context(branch, () => true),
      [
        async () => ({
          deliveryId: "notification:one",
          findSessionEntryId: (entries) => (entries[0] as { id?: string } | undefined)?.id,
          send,
          settle,
        }),
      ],
    );

    expect(send).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith("entry-existing");
  });

  it("releases the local guard when sendMessage throws before queueing", async () => {
    const coordinator = new SessionDeliveryCoordinator();
    const send = vi.fn(() => {
      throw new Error("send failed");
    });
    const claim = vi.fn(
      async (): Promise<ClaimedSessionDelivery> => ({
        deliveryId: "turn:one",
        findSessionEntryId: () => undefined,
        send,
        settle: async () => {},
      }),
    );
    const ctx = context([], () => true);

    await expect(coordinator.synchronize(ctx, [claim])).rejects.toThrow("send failed");
    await expect(coordinator.synchronize(ctx, [claim])).rejects.toThrow("send failed");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
