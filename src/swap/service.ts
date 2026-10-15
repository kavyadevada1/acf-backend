import { decodeEventLog, getAddress } from "viem";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { chainReader, type SwapReader } from "../lib/chain.js";
import { DIRECTION, swapExecutedEventAbi } from "../abi/swapEvent.js";
import { Swap, type SwapDocument } from "../models/Swap.js";
import { User } from "../models/User.js";

export interface SwapResponse {
  eventId: string;
  direction: "BUY" | "SELL";
  acfAmount: string;
  grossUSDT: string;
  sellFeeUSDT: string;
  netUSDT: string;
  blockNumber: number;
  txHash: string;
  blockTimestamp: string;
}

export interface SwapVolume {
  buyUSDT: string;
  sellGrossUSDT: string;
  feesPaidUSDT: string;
  count: number;
}

const toResponse = (s: SwapDocument): SwapResponse => ({
  eventId: s.eventId,
  direction: s.direction as "BUY" | "SELL",
  acfAmount: s.acfAmount,
  grossUSDT: s.grossUSDT,
  sellFeeUSDT: s.sellFeeUSDT,
  netUSDT: s.netUSDT,
  blockNumber: s.blockNumber,
  txHash: s.txHash,
  blockTimestamp: s.blockTimestamp.toISOString(),
});

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Records a swap from its transaction hash.
 *
 * The hash is the ONLY thing taken from the caller. Everything stored is decoded from the
 * receipt the backend fetches itself, and the log's `user` must be this account's own address —
 * so a hash belonging to somebody else's trade, to another contract, or to nothing at all
 * cannot create a row. Swap volume feeds reward calculations later, which is exactly why no
 * client-reported amount is trusted here.
 */
export async function recordSwap(
  userId: string,
  rawTxHash: unknown,
  reader: SwapReader = chainReader,
): Promise<SwapResponse> {
  if (typeof rawTxHash !== "string" || !TX_HASH.test(rawTxHash.trim())) {
    throw new HttpError(400, "INVALID_TX_HASH", "A 32-byte transaction hash is required.");
  }
  const txHash = rawTxHash.trim().toLowerCase();

  const user = await User.findOne({ userId });
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "User no longer exists.");
  // `externalEOA` is required and immutable on every user, so an absent value is a corrupt
  // record rather than a state the caller can resolve by onboarding.
  if (!user.externalEOA) {
    throw new HttpError(500, "INTERNAL_ERROR", "This account has no address on record.");
  }
  const userAddress = user.externalEOA.toLowerCase();

  let receipt;
  let head: bigint;
  try {
    [receipt, head] = await Promise.all([reader.receiptOf(txHash), reader.headBlock()]);
  } catch {
    throw new HttpError(503, "CHAIN_UNAVAILABLE", "Could not reach the network. Try again.");
  }

  if (!receipt) throw new HttpError(404, "TX_NOT_FOUND", "That transaction is not on chain yet.");
  if (receipt.status !== "success") {
    throw new HttpError(409, "TX_REVERTED", "That transaction did not succeed.");
  }

  const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(config.swapConfirmations)) {
    throw new HttpError(425, "NOT_CONFIRMED", "The transaction needs more confirmations.");
  }

  const swapAddress = getAddress(config.acfSwapAddress).toLowerCase();

  for (const log of receipt.logs) {
    // Only logs emitted BY the configured Swap contract are considered.
    if (log.address !== swapAddress) continue;

    let decoded;
    try {
      decoded = decodeEventLog({
        abi: swapExecutedEventAbi,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
    } catch {
      continue; // some other event from the same contract
    }
    if (decoded.eventName !== "SwapExecuted") continue;

    const args = decoded.args as unknown as {
      user: string; direction: number;
      acfAmount: bigint; grossUSDT: bigint; sellFeeUSDT: bigint;
    };

    // The trade must belong to THIS account.
    if (args.user.toLowerCase() !== userAddress) continue;

    const direction = DIRECTION[args.direction as 0 | 1];
    if (!direction) continue;

    const eventId = `${config.chainId}:${txHash}:${log.logIndex}`;
    const existing = await Swap.findOne({ eventId });
    if (existing) return toResponse(existing); // idempotent: replaying the hash changes nothing

    const timestamp = await reader.blockTimestamp(receipt.blockNumber);

    const created = await Swap.findOneAndUpdate(
      { eventId },
      {
        $setOnInsert: {
          eventId,
          userId,
          externalEOA: userAddress,
          direction,
          acfAmount: args.acfAmount.toString(),
          grossUSDT: args.grossUSDT.toString(),
          sellFeeUSDT: args.sellFeeUSDT.toString(),
          netUSDT: (args.grossUSDT - args.sellFeeUSDT).toString(),
          blockNumber: Number(receipt.blockNumber),
          txHash,
          logIndex: log.logIndex,
          blockTimestamp: new Date(Number(timestamp) * 1000),
        },
      },
      { upsert: true, new: true },
    );
    return toResponse(created!);
  }

  throw new HttpError(
    422,
    "NO_SWAP_FOR_WALLET",
    "That transaction contains no swap belonging to this account.",
  );
}

export async function listSwaps(
  userId: string,
  limit = 25,
): Promise<{ swaps: SwapResponse[]; volume: SwapVolume }> {
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = await Swap.find({ userId }).sort({ blockNumber: -1, logIndex: -1 }).limit(capped);

  // Totals are aggregated over every row rather than kept in a counter, so they cannot drift
  // out of step with the underlying records.
  const all = await Swap.find({ userId }).select("direction grossUSDT sellFeeUSDT");
  let buy = 0n, sellGross = 0n, fees = 0n;
  for (const s of all) {
    if (s.direction === "BUY") buy += BigInt(s.grossUSDT);
    else sellGross += BigInt(s.grossUSDT);
    fees += BigInt(s.sellFeeUSDT);
  }

  return {
    swaps: rows.map(toResponse),
    volume: {
      buyUSDT: buy.toString(),
      sellGrossUSDT: sellGross.toString(),
      feesPaidUSDT: fees.toString(),
      count: all.length,
    },
  };
}
