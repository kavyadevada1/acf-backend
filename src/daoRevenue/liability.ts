import { getAddress } from "viem";
import { config } from "../config.js";
import { RewardSettlementCheckpoint } from "../models/RewardSettlementCheckpoint.js";
import { DAORevenueInvariantError } from "./policy.js";
import { type DAORevenueChainReader } from "./chain.js";

/**
 * How much ACF the Treasury must still hold for Phase 3, so DAO funding cannot spend it.
 *
 * WHY THIS IS NECESSARY
 * ---------------------
 * DAO revenue funding and standard reward funding draw on the SAME Treasury ACF balance, and
 * nothing on chain enforces the reserve. Checking only `balance - daoObligation >=
 * requiredReserve` is insufficient, because a Phase 3 checkpoint can already be CALCULATED and
 * calculated and still waiting to be funded:
 *
 *   balance 1,000   requiredReserve 600   pending Phase 3 300   DAO obligation 200
 *   naive:  1,000 - 200 = 800 >= 600                        -> PASS
 *   truth:  600 reserve + 300 Phase 3 = 900 needed, 800 left -> the operator can no longer
 *                                                              fund the reward checkpoint
 *
 * DAO revenue is a push the backend automates; Phase 3 funding is a manual operator step. So
 * the automated side must yield to the manual one, never the reverse.
 *
 * This module READS Phase 3 state. It does not alter Phase 3 logic, and Phase 4 has no code
 * path that funds or finalizes a standard reward epoch.
 */

/**
 * Checkpoint states whose obligation is still owed.
 *
 * FINALIZED is settled and FAILED is abandoned, so neither reserves anything. CALCULATING is
 * excluded deliberately: it is an in-progress calculation whose numbers are not yet trusted —
 * and it is also why `pendingCheckpoints` reports it separately rather than ignoring it.
 */
const OWED = ["CALCULATED", "FUNDING_SUBMITTED", "FUNDED", "FINALIZE_SUBMITTED"];

export interface StandardLiability {
  /** ACF that must remain for Phase 3, after consulting the chain. */
  reservedACF: bigint;
  /** Which checkpoints contributed, for the operator's report. */
  checkpoints: Array<{ checkpointId: number; status: string; deltaACF: string; fundedOnChain: boolean }>;
  /** Set when the liability cannot be sized safely; execution must then STOP. */
  undetermined: string | null;
}

/**
 * Sizes the outstanding Phase 3 liability from immutable settlement data plus chain truth.
 *
 * Deliberately conservative in both directions:
 *  - a checkpoint the chain says is already funded reserves nothing;
 *  - a checkpoint still unfunded reserves its exact `publishedDeltaACF`;
 *  - anything ambiguous returns `undetermined`, and the caller STOPS rather than assuming zero.
 */
export async function standardRewardLiability(
  reader: DAORevenueChainReader,
): Promise<StandardLiability> {
  const settle = {
    chainId: config.chainId,
    withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
  };

  // An in-progress calculation makes the liability unknowable: its delta is not yet written, so
  // reserving zero could let DAO funding consume what it is about to claim.
  const calculating = await RewardSettlementCheckpoint.countDocuments({
    ...settle, status: "CALCULATING",
  });
  if (calculating > 0) {
    return {
      reservedACF: 0n,
      checkpoints: [],
      undetermined:
        `${calculating} settlement checkpoint(s) are still CALCULATING, so the outstanding ` +
        "standard-reward obligation cannot be sized. Refusing to guess zero.",
    };
  }

  const owed = await RewardSettlementCheckpoint.find(
    { ...settle, status: { $in: OWED }, legacy: false },
    { checkpointId: 1, status: 1, publishedDeltaACF: 1 },
  ).sort({ checkpointId: 1 }).lean();

  let reservedACF = 0n;
  const checkpoints: StandardLiability["checkpoints"] = [];

  for (const checkpoint of owed) {
    const delta = BigInt(checkpoint.publishedDeltaACF);
    if (delta < 0n) {
      return {
        reservedACF: 0n,
        checkpoints: [],
        undetermined:
          `Settlement checkpoint ${checkpoint.checkpointId} records a negative published delta ` +
          `${delta}. Refusing to size a liability from inconsistent settlement data.`,
      };
    }

    let fundedOnChain: boolean;
    try {
      fundedOnChain = await reader.standardRewardEpochFunded(checkpoint.checkpointId);
    } catch (cause) {
      return {
        reservedACF: 0n,
        checkpoints: [],
        undetermined:
          `Could not read Treasury.rewardEpochFunded(${checkpoint.checkpointId}): ` +
          `${(cause as Error).message}. Refusing to assume the obligation is settled.`,
      };
    }

    // A checkpoint recorded as FUNDED locally but unfunded on chain is a real disagreement: one
    // of the two is wrong about whether Treasury assets have already moved.
    if (!fundedOnChain && (checkpoint.status === "FUNDED" || checkpoint.status === "FINALIZE_SUBMITTED")) {
      return {
        reservedACF: 0n,
        checkpoints: [],
        undetermined:
          `Settlement checkpoint ${checkpoint.checkpointId} is ${checkpoint.status} locally but ` +
          "Treasury.rewardEpochFunded reports false. Settlement state and chain disagree; " +
          "refusing to size the liability.",
      };
    }

    if (!fundedOnChain) reservedACF += delta;
    checkpoints.push({
      checkpointId: checkpoint.checkpointId,
      status: checkpoint.status,
      deltaACF: delta.toString(),
      fundedOnChain,
    });
  }

  return { reservedACF, checkpoints, undetermined: null };
}

/** Raised when DAO funding would eat into the reserve or Phase 3's pending obligation. */
export class InsufficientHeadroomError extends DAORevenueInvariantError {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientHeadroomError";
  }
}
