import { getAddress } from "viem";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { User } from "../models/User.js";
import { RewardSettlementCheckpoint } from "../models/RewardSettlementCheckpoint.js";
import { UserRewardCheckpoint } from "../models/UserRewardCheckpoint.js";
import { buildSettlementTree, type BuiltTree } from "./merkle.js";
import type { SettlementLeaf } from "./policy.js";
import { settlementChainReader, type SettlementChainReader } from "./chain.js";

/**
 * On-demand proof generation.
 *
 * Proofs are never stored: the Withdrawal contract keeps only the latest root, so the next
 * finalization invalidates every proof issued against the previous one. A cached proof would
 * be a support incident waiting to happen.
 *
 * The tree is rebuilt from the checkpoint's leaf rows and cached in process, keyed by
 * checkpoint and root, and the cache is only used while the LIVE root still matches.
 */

const cache = new Map<string, BuiltTree>();

function cacheTree(key: string, tree: BuiltTree): BuiltTree {
  cache.set(key, tree);
  while (cache.size > config.settlementProofCacheSize) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return tree;
}

const settlementKey = () => ({
  chainId: config.chainId,
  withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
});

export interface ClaimProof {
  checkpointId: number;
  root: string;
  liveRoot: string;
  cumulativeSelfACF: string;
  cumulativeTeamACF: string;
  alreadyClaimedACF: string;
  proof: string[];
}

export type ClaimProofResult =
  | { status: "NOTHING_TO_CLAIM"; claimable: false; reason: string }
  | ({ status: "CLAIMABLE"; claimable: true } & ClaimProof);

export async function buildClaimProof(
  userId: string,
  reader: SettlementChainReader = settlementChainReader,
): Promise<ClaimProofResult> {
  const settle = settlementKey();

  const user = await User.findOne({ userId }, { externalEOA: 1 }).lean();
  if (!user?.externalEOA) {
    // Required and immutable on every user, so this is a corrupt record, not a claimable state.
    throw new HttpError(500, "INTERNAL_ERROR", "This account has no address on record.");
  }
  // The leaf is keyed to this address, and the contract derives the same address from
  // msg.sender when the user claims. No translation, so no proof can be built for anyone else.
  const claimant = user.externalEOA.toLowerCase();

  const cp = await RewardSettlementCheckpoint.findOne({ ...settle, status: "FINALIZED" })
    .sort({ checkpointId: -1 });
  if (!cp) return { status: "NOTHING_TO_CLAIM", claimable: false, reason: "NO_FINALIZED_CHECKPOINT" };

  // The proof must be valid against the root the contract holds RIGHT NOW.
  const live = await reader.liveState();
  if (live.root !== cp.root || live.latestEpochId !== cp.checkpointId) {
    throw new HttpError(
      503, "SETTLEMENT_STALE",
      "On-chain settlement state does not match the latest calculated checkpoint. A proof " +
        "issued now could not be verified.",
    );
  }

  const row = await UserRewardCheckpoint.findOne({
    ...settle, checkpointId: cp.checkpointId, userId,
  }).lean();
  if (!row) return { status: "NOTHING_TO_CLAIM", claimable: false, reason: "NOT_IN_CHECKPOINT" };

  /**
   * The ROOT-rotation window.
   *
   * The logical referral root is the one user whose address can change — rebound to whatever
   * `ACFWithdrawal.currentRootEOA()` now says. When that happens between checkpoints, the live
   * checkpoint still carries a leaf for the PREVIOUS address, so no proof exists for the current
   * one yet.
   *
   * Nothing is lost, and nothing is paid twice. The next checkpoint carries the same cumulative
   * forward onto the new address, and the contract settles it against the ONE claim watermark
   * every ROOT EOA shares, so the incoming address draws the delta above whatever the outgoing one
   * already took — never the whole cumulative again. The window is a deferral of at most one
   * checkpoint, not a loss and not an opening.
   *
   * Reported as a plain state rather than left to fail inside the tree, where it would surface as
   * an internal error on a perfectly healthy account. A mismatch for any OTHER user is still a
   * genuine integrity failure and still throws below.
   */
  if (row.externalEOA.toLowerCase() !== claimant) {
    return {
      status: "NOTHING_TO_CLAIM",
      claimable: false,
      reason: "AWAITING_REBOUND_CHECKPOINT",
    };
  }

  const claimedMap = await reader.alreadyClaimed([claimant]);
  const alreadyClaimed = claimedMap.get(claimant) ?? 0n;
  const combined = BigInt(row.combinedCumulativeACF);
  if (combined <= alreadyClaimed) {
    return { status: "NOTHING_TO_CLAIM", claimable: false, reason: "FULLY_CLAIMED" };
  }

  const key = `${cp.checkpointId}:${cp.root}`;
  let tree = cache.get(key);
  if (!tree) {
    const rows = await UserRewardCheckpoint.find(
      { ...settle, checkpointId: cp.checkpointId },
      { externalEOA: 1, cumulativeSelfACF: 1, cumulativeTeamACF: 1 },
    ).lean();
    const leaves: SettlementLeaf[] = rows.map((r) => ({
      externalEOA: r.externalEOA,
      cumulativeSelfACF: BigInt(r.cumulativeSelfACF),
      cumulativeTeamACF: BigInt(r.cumulativeTeamACF),
    }));
    const built = buildSettlementTree(leaves);
    if (built.root !== cp.root) {
      throw new HttpError(
        500, "SETTLEMENT_ROOT_MISMATCH",
        `Rebuilt root ${built.root} does not match stored checkpoint root ${cp.root}.`,
      );
    }
    tree = cacheTree(key, built);
  }

  return {
    status: "CLAIMABLE",
    claimable: true,
    checkpointId: cp.checkpointId,
    root: cp.root,
    liveRoot: live.root,
    cumulativeSelfACF: row.cumulativeSelfACF,
    cumulativeTeamACF: row.cumulativeTeamACF,
    alreadyClaimedACF: alreadyClaimed.toString(),
    proof: tree.proofFor(claimant),
  };
}

/** Test seam: the cache is process-local and must not leak between cases. */
export const __clearProofCache = () => cache.clear();
