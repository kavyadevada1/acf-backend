import { getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { RewardSettlementCheckpoint } from "../models/RewardSettlementCheckpoint.js";
import { UserClaimState } from "../models/UserClaimState.js";
import { UserRewardCheckpoint } from "../models/UserRewardCheckpoint.js";
import { assertInvariant } from "./policy.js";
import { settlementChainReader, type SettlementChainReader } from "./chain.js";

/**
 * Moves settlement state forward from CHAIN STATE, never from a local flag.
 *
 * A crash between an operator's transaction confirming and the backend recording it must not
 * cause a second authorization, a second funding or a second finalization. So the question asked
 * is always "is the chain in the target state?" — which also handles a replacement transaction,
 * and an operator who acted entirely out of band.
 *
 * Where the chain holds a commitment that does not match what was calculated, this FAILS LOUDLY
 * rather than adopting it. That commitment is immutable; adopting it would mean serving proofs
 * against a tree the backend did not build.
 */

const settlementKey = () => ({
  chainId: config.chainId,
  withdrawalAddress: getAddress(config.withdrawalAddress).toLowerCase(),
});

export class ClaimReconciliationError extends Error {
  readonly code = "CLAIM_RECONCILIATION";
  constructor(message: string) {
    super(message);
    this.name = "ClaimReconciliationError";
  }
}

export interface CheckpointReconciliation {
  checkpointId: number;
  statusBefore: string;
  statusAfter: string;
  auditWarning: string | null;
}

/** Reconciles the newest non-finalized checkpoint against the chain. */
export async function reconcileSettlementCheckpoint(
  reader: SettlementChainReader = settlementChainReader,
): Promise<CheckpointReconciliation | null> {
  const settle = settlementKey();
  const cp = await RewardSettlementCheckpoint.findOne({
    ...settle, status: { $nin: ["FINALIZED", "FAILED"] },
  }).sort({ checkpointId: -1 });
  if (!cp) return null;

  const statusBefore = cp.status;
  let status = cp.status;
  let auditWarning: string | null = cp.auditWarning ?? null;

  // ── authorization: chain evidence, never a local intent ──────────────────
  //
  // The commitment is immutable, so a chain commitment that disagrees with what this checkpoint
  // calculated can never be corrected by another transaction. It is reported as a hard failure
  // rather than reconciled away: the database is NOT the authority here, and quietly accepting a
  // different root would mean publishing one the backend cannot build proofs against.
  const authorization = await reader.rewardEpochAuthorization(cp.checkpointId);
  if (authorization.authorized) {
    assertInvariant(
      authorization.cumulativeMerkleRoot === cp.root,
      `Checkpoint ${cp.checkpointId} is authorized on chain with root ` +
        `${authorization.cumulativeMerkleRoot}, not ${cp.root}.`,
    );
    assertInvariant(
      authorization.cumulativeTotalEntitlementACF === BigInt(cp.publishedCumulativeTotalACF),
      `Checkpoint ${cp.checkpointId} is authorized with cumulative total ` +
        `${authorization.cumulativeTotalEntitlementACF}, expected ${cp.publishedCumulativeTotalACF}.`,
    );
    assertInvariant(
      authorization.fundingAmountACF === BigInt(cp.publishedDeltaACF),
      `Checkpoint ${cp.checkpointId} is authorized with funding ` +
        `${authorization.fundingAmountACF}, expected ${cp.publishedDeltaACF}.`,
    );
    if (status === "CALCULATED") {
      status = "AUTHORIZED";
      if (!cp.authorizationTxHash) {
        // Financially complete, audit-incomplete. Never a reason to authorize again — and a
        // second attempt would revert, because the commitment is one-time.
        auditWarning = `Authorization confirmed on chain for checkpoint ${cp.checkpointId}, but ` +
          "no local transaction hash is known.";
      }
    }
  }

  const funded = await reader.rewardEpochFunded(cp.checkpointId);
  if (funded && (status === "CALCULATED" || status === "AUTHORIZED" || status === "FUNDING_SUBMITTED")) {
    status = "FUNDED";
    if (!cp.fundingTxHash) {
      // Financially complete, audit-incomplete. Never a reason to fund again.
      auditWarning = `Funding confirmed on chain for checkpoint ${cp.checkpointId}, but no local ` +
        "transaction hash is known.";
    }
  }

  const finalized = await reader.epochFinalized(cp.checkpointId);
  if (finalized) {
    const live = await reader.liveState();
    // A finalized flag alone is not enough: the live root and total must be OURS, or some other
    // tree is what users will be claiming against.
    assertInvariant(
      live.latestEpochId === cp.checkpointId,
      `Checkpoint ${cp.checkpointId} is finalized but Withdrawal.latestEpochId is ${live.latestEpochId}.`,
    );
    assertInvariant(
      live.root === cp.root,
      `Checkpoint ${cp.checkpointId} is finalized but the live root is ${live.root}, not ${cp.root}.`,
    );
    assertInvariant(
      live.cumulativeTotalEntitlementACF === BigInt(cp.publishedCumulativeTotalACF),
      `Checkpoint ${cp.checkpointId} finalized with total ${live.cumulativeTotalEntitlementACF}, ` +
        `expected ${cp.publishedCumulativeTotalACF}.`,
    );
    status = "FINALIZED";
    if (!cp.finalizeTxHash) {
      auditWarning = `Finalization confirmed on chain for checkpoint ${cp.checkpointId}, but no ` +
        "local transaction hash is known.";
    }
  }

  if (status !== statusBefore || auditWarning !== (cp.auditWarning ?? null)) {
    await RewardSettlementCheckpoint.updateOne(
      { ...settle, checkpointId: cp.checkpointId },
      {
        $set: {
          status, auditWarning, leaseExpiresAt: null,
          ...(status !== "CALCULATED" && !cp.authorizedAt ? { authorizedAt: new Date() } : {}),
        },
      },
    );
    logger.info("settlement checkpoint reconciled", {
      checkpointId: cp.checkpointId, statusBefore, statusAfter: status,
    });
  }

  return { checkpointId: cp.checkpointId, statusBefore, statusAfter: status, auditWarning };
}

export interface ClaimStateResult {
  reconciled: number;
  claimed: number;
}

/**
 * Brings every published wallet's claim watermark in line with the chain.
 *
 * The match must be EXACT. `claim()` always takes the entire available balance and writes
 * alreadyClaimed = cumulativeSelf + cumulativeTeam from a leaf this backend published, so a
 * value strictly between two published totals is unreachable through the contract — it would
 * mean corrupt data or an unknown publisher. A `<=` match would quietly retire components the
 * user never claimed.
 *
 * Where several checkpoints share a combined total, any of them is correct: equal combined
 * totals with individually non-decreasing Self and Team force both to be equal, so no reward
 * was published between them and the component coverage is identical. The latest is taken.
 */
export async function reconcileClaimStates(
  reader: SettlementChainReader = settlementChainReader,
): Promise<ClaimStateResult> {
  const settle = settlementKey();
  const finalizedIds = (await RewardSettlementCheckpoint.find(
    { ...settle, status: "FINALIZED" }, { checkpointId: 1 },
  ).lean()).map((c) => c.checkpointId);
  if (finalizedIds.length === 0) return { reconciled: 0, claimed: 0 };

  const rows = await UserRewardCheckpoint.find(
    { ...settle, checkpointId: { $in: finalizedIds } },
    { userId: 1, externalEOA: 1, checkpointId: 1, combinedCumulativeACF: 1 },
  ).lean();
  if (rows.length === 0) return { reconciled: 0, claimed: 0 };

  const wallets = [...new Set(rows.map((r) => r.externalEOA))];
  const onChain = await reader.alreadyClaimed(wallets);
  const block = await reader.blockNumber();

  // Highest-first, so the first exact match is the latest qualifying checkpoint.
  const byWallet = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byWallet.get(r.externalEOA) ?? [];
    list.push(r);
    byWallet.set(r.externalEOA, list);
  }

  let reconciled = 0;
  let claimed = 0;

  for (const [wallet, list] of byWallet) {
    const X = onChain.get(wallet) ?? 0n;
    list.sort((a, b) => b.checkpointId - a.checkpointId);
    const userId = list[0]!.userId;

    let highestClaimedCheckpointId: number | null = null;
    if (X > 0n) {
      const match = list.find((r) => BigInt(r.combinedCumulativeACF) === X);
      if (!match) {
        throw new ClaimReconciliationError(
          `alreadyClaimed(${wallet}) is ${X}, which matches no finalized published cumulative ` +
            "total for that wallet. Refusing to guess which checkpoint was claimed.",
        );
      }
      highestClaimedCheckpointId = match.checkpointId;
      claimed += 1;
    }

    await UserClaimState.findOneAndUpdate(
      { ...settle, userId },
      {
        $set: {
          externalEOA: wallet,
          alreadyClaimedACF: X.toString(),
          highestClaimedCheckpointId,
          lastReconciledBlock: block,
          lastReconciledAt: new Date(),
        },
        $setOnInsert: { ...settle, userId },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    reconciled += 1;
  }

  return { reconciled, claimed };
}
