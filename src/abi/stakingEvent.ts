/**
 * Staking ABI fragments used by the backend. Deliberately separate from the swap ABI so the
 * completed swap module is untouched.
 */

export const stakeCreatedEventAbi = [
  {
    type: "event",
    name: "StakeCreated",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "stakeId", type: "uint256", indexed: true },
      { name: "poolId", type: "uint256", indexed: true },
      { name: "principal", type: "uint256", indexed: false },
      /**
       * The pool's ROI at creation time. HISTORICAL CONTEXT ONLY — it is not this stake's
       * reward rate. Pool ROI is mutable, and the authoritative rate for any epoch is the
       * reward job's epoch-start snapshot. The contract stores zero on the position for the
       * same reason.
       */
      { name: "poolDailyROIAtCreation", type: "uint256", indexed: false },
      { name: "stakeTimestamp", type: "uint256", indexed: false },
      { name: "unlockTimestamp", type: "uint256", indexed: false },
      // enum StakeSource { DIRECT, BOND, DAO }
      { name: "source", type: "uint8", indexed: false },
    ],
  },
] as const;

/** Read used only by the startup guard against the stale Amoy staking proxy. */
export const stakingReadAbi = [
  { type: "function", name: "acf", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const STAKE_SOURCE = { 0: "DIRECT", 1: "BOND", 2: "DAO" } as const;
