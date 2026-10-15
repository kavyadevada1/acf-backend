/**
 * ACFDAO ABI fragments for the fresh (V2) deployment.
 *
 * Deliberately narrow: only what the user-facing backend needs. The removed Merkle voting
 * surface (votingEligibilityRoot / eligibilityRootVersion / setVotingEligibilityRoot) does not
 * exist on this contract, and no admin write is declared here, so it cannot be called by accident.
 * StakeCreated is reused from abi/stakingEvent.ts rather than duplicated.
 */

export const daoContributionCreatedEventAbi = [
  {
    type: "event",
    name: "DAOContributionCreated",
    inputs: [
      { name: "contributionId", type: "uint256", indexed: true },
      { name: "beneficiary", type: "address", indexed: true },
      // Links this contribution to the Staking position created in the same transaction.
      { name: "stakeId", type: "uint256", indexed: true },
      { name: "poolId", type: "uint256", indexed: false },
      { name: "usdtContributed", type: "uint256", indexed: false },
      { name: "acfStaked", type: "uint256", indexed: false },
      { name: "executionPriceE18", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Canonical dependency getters, used by the startup assertion. */
export const daoReadAbi = [
  { type: "function", name: "acf", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "usdt", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "als", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "staking", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "swap", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** Configuration and contribution reads. */
export const daoStateAbi = [
  {
    type: "function",
    name: "getRevenueConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "silverMinimumUSDT", type: "uint256" },
          { name: "goldMinimumUSDT", type: "uint256" },
          // ONE shared member pool. Silver and Gold are labels and draw from the same pool.
          { name: "memberRevenuePercentage", type: "uint256" },
          { name: "marketingPercentage", type: "uint256" },
        ],
      },
    ],
  },
  { type: "function", name: "daoPoolId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "DAO_LOCK_DURATION", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "revenueEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "daoClosed", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "nextContributionId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "getContribution",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "beneficiary", type: "address" },
          { name: "usdtContributed", type: "uint256" },
          { name: "acfStaked", type: "uint256" },
          { name: "poolId", type: "uint256" },
          { name: "stakeId", type: "uint256" },
          { name: "timestamp", type: "uint256" },
        ],
      },
    ],
  },
  {
    // Reads the linked Staking position's CURRENT state; maturity alone never makes it false.
    type: "function",
    name: "isContributionActive",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Only the pool fields needed to prove the DAO's pinned pool really carries the 750-day term. */
export const stakingPoolAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "lockDuration", type: "uint256" },
          { name: "minDailyRewardRate", type: "uint256" },
          { name: "maxDailyRewardRate", type: "uint256" },
          // Dynamic ROI for ordinary DIRECT stakers. NEVER the DAO rate: see dao/policy.ts.
          { name: "currentDailyRewardRate", type: "uint256" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getStake",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "stakeId", type: "uint256" },
          { name: "user", type: "address" },
          { name: "principal", type: "uint256" },
          { name: "poolId", type: "uint256" },
          { name: "dailyRewardRate", type: "uint256" },
          { name: "stakeTimestamp", type: "uint256" },
          { name: "unlockTimestamp", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "source", type: "uint8" },
        ],
      },
    ],
  },
] as const;

/** Reads the reward engine uses for canonical stake discovery and pool snapshots. */
export const stakingRewardAbi = [
  { type: "function", name: "nextStakeId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextPoolId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
