/** Implementation and semantic repair share the same bounded work allowance. */
export const IMPLEMENTATION_TIMEOUT_MS = 8 * 60 * 60_000;

/** Verification planning allows one full correction turn beyond the observed 15-minute failure. */
export const VERIFICATION_PLANNING_TIMEOUT_MS = 30 * 60_000;
