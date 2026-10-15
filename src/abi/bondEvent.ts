/**
 * Bond ABI fragments. Separate from the staking and swap ABIs so completed modules stay
 * untouched; StakeCreated is reused from abi/stakingEvent.ts rather than duplicated.
 */

export const bondPurchasedEventAbi = [
  {
    type: "event",
    name: "BondPurchased",
    inputs: [
      { name: "purchaseId", type: "uint256", indexed: true },
      { name: "beneficiary", type: "address", indexed: true },
      { name: "offerId", type: "uint256", indexed: true },
      { name: "poolId", type: "uint256", indexed: false },
      // Links this purchase to the Staking position created in the same transaction.
      { name: "stakeId", type: "uint256", indexed: false },
      { name: "usdtPaid", type: "uint256", indexed: false },
      // Against DISCOUNT_DENOMINATOR = 1_000_000: 50_000 is 5%.
      { name: "discountUsed", type: "uint256", indexed: false },
      { name: "executionPriceE18", type: "uint256", indexed: false },
      { name: "acfStaked", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Reads used only by the startup dependency assertions. */
export const bondReadAbi = [
  { type: "function", name: "acf", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "usdt", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "staking", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "swap", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
