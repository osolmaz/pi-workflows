export const ORIGIN_ACTIVITY_REFRESH_MS = 1_000;
export const ORIGIN_ACTIVITY_LEASE_MS = 4_000;

if (ORIGIN_ACTIVITY_REFRESH_MS >= ORIGIN_ACTIVITY_LEASE_MS) {
  throw new Error("Origin activity refresh period must be shorter than its lease");
}
