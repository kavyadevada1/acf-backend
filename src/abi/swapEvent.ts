/**
 * The one event this milestone decodes. The backend reads swap facts from the chain itself —
 * nothing about a trade is ever accepted from a client.
 */
export const swapExecutedEventAbi = [
  {
    type: "event",
    name: "SwapExecuted",
    inputs: [
      { name: "user", type: "address", indexed: true },
      // enum Direction { BUY, SELL } — 0 and 1 respectively.
      { name: "direction", type: "uint8", indexed: true },
      { name: "acfAmount", type: "uint256", indexed: false },
      { name: "grossUSDT", type: "uint256", indexed: false },
      { name: "sellFeeUSDT", type: "uint256", indexed: false },
      { name: "cumulativeBuyVolume", type: "uint256", indexed: false },
      { name: "cumulativeSellVolume", type: "uint256", indexed: false },
    ],
  },
] as const;

export const DIRECTION = { 0: "BUY", 1: "SELL" } as const;

/** The epoch price source. One read per epoch, reused for every USD conversion in it. */
export const acfSwapPriceAbi = [
  { type: "function", name: "priceE18", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
