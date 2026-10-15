import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One cumulative settlement checkpoint: the bridge between immutable reward history and the
 * single Merkle root the Withdrawal contract holds.
 *
 * `checkpointId` is an INDEPENDENT monotonic settlement sequence, not a reward epoch id. It is
 * the number passed to Treasury.fundRewardEpoch and Withdrawal.finalizeEpoch, so it must match
 * the on-chain epoch identity exactly. The reward relationship is explicit through
 * fromRewardEpochId / throughRewardEpochId.
 *
 * Everything above the state-machine block is immutable once the checkpoint reaches CALCULATED:
 * the root is published to a contract that keeps no history, so a changed leaf population or
 * total after calculation would silently invalidate every proof already handed out.
 *
 * AUTHORIZED is the step between calculation and execution, and the backend is not its authority.
 * It means ACFWithdrawal holds an immutable commitment to this checkpoint's root, cumulative total
 * and funding amount, accepted by REWARD_AUTHORIZER_ROLE. Nothing can be funded or finalized
 * before it, and the status is only ever set from chain evidence — never from a local intent.
 */
const RewardSettlementCheckpointSchema = new Schema(
  {
    chainId: { type: Number, required: true, immutable: true },
    stakingContractAddress: { type: String, required: true, immutable: true, lowercase: true },
    /** Part of the identity: the cumulative ledger lives in THIS contract. */
    withdrawalAddress: { type: String, required: true, immutable: true, lowercase: true },
    treasuryAddress: { type: String, required: true, immutable: true, lowercase: true },

    checkpointId: { type: Number, required: true, immutable: true },
    /**
     * Marked a settlement that was already finalized on chain before this system existed.
     *
     * No code path can set it any more — the seeder that did was retired with the old deployment
     * — so it is permanently false on every new checkpoint. The executor, manifest and DAO
     * revenue liability still filter on it, and those filters are kept: they cost nothing and
     * removing them would mean editing financial queries for no behavioural change.
     */
    legacy: { type: Boolean, required: true, default: false, immutable: true },

    /** Null when the checkpoint corresponds to no reward epoch range. */
    fromRewardEpochId: { type: Number, default: null, immutable: true },
    throughRewardEpochId: { type: Number, default: null, immutable: true },
    /**
     * Null on the FIRST checkpoint of a deployment: it chains from the virgin contract's zero
     * baseline, which is derived state rather than a stored checkpoint. See `resolvePredecessor`.
     */
    previousCheckpointId: { type: Number, default: null, immutable: true },

    root: { type: String, required: true, immutable: true, lowercase: true },

    /** Σ over leaves of (cumulativeSelf + cumulativeTeam). Computed FROM the leaves. */
    publishedCumulativeTotalACF: { type: String, required: true, immutable: true },
    /** newTotal − previousTotal. This, not the earned delta, is what Treasury must fund. */
    publishedDeltaACF: { type: String, required: true, immutable: true },
    leafCount: { type: Number, required: true, immutable: true },

    totalNewSelfACF: { type: String, required: true, immutable: true },
    totalNewTeamACF: { type: String, required: true, immutable: true },
    /** Entitlement withheld by an earlier checkpoint and released by this one. */
    totalDeferredReleasedSelfACF: { type: String, required: true, immutable: true },
    totalDeferredReleasedTeamACF: { type: String, required: true, immutable: true },

    // ── state machine: the only mutable fields ──────────────────────────────
    status: {
      type: String,
      required: true,
      enum: [
        "CALCULATING", "CALCULATED", "AUTHORIZED", "FUNDING_SUBMITTED", "FUNDED",
        "FINALIZE_SUBMITTED", "FINALIZED", "FAILED",
      ],
      default: "CALCULATING",
    },
    leaseExpiresAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String, default: null },

    /**
     * The transaction in which REWARD_AUTHORIZER_ROLE committed this checkpoint on chain.
     *
     * Null is not "unauthorized": the chain is the authority, so an authorization confirmed out of
     * band leaves the status correct and only the audit trail incomplete.
     */
    authorizationTxHash: { type: String, default: null, lowercase: true },
    authorizationBlockNumber: { type: Number, default: null },
    authorizedAt: { type: Date, default: null },

    fundingTxHash: { type: String, default: null, lowercase: true },
    fundingBlockNumber: { type: Number, default: null },
    fundingBlockTimestamp: { type: Number, default: null },

    finalizeTxHash: { type: String, default: null, lowercase: true },
    finalizedBlockNumber: { type: Number, default: null },
    finalizedBlockTimestamp: { type: Number, default: null },

    /**
     * Set when the chain proves a step complete but the local transaction hash is unknown —
     * an operator acted out of band. Financially complete, audit-incomplete; never a reason
     * to resend.
     */
    auditWarning: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, strict: true },
);

RewardSettlementCheckpointSchema.index(
  { chainId: 1, withdrawalAddress: 1, checkpointId: 1 },
  { unique: true },
);
RewardSettlementCheckpointSchema.index(
  { chainId: 1, withdrawalAddress: 1, status: 1, checkpointId: -1 },
);

export type RewardSettlementCheckpointDocument =
  InferSchemaType<typeof RewardSettlementCheckpointSchema>;
export const RewardSettlementCheckpoint =
  model("RewardSettlementCheckpoint", RewardSettlementCheckpointSchema);
