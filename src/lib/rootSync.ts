import { User, type UserDocument } from "../models/User.js";
import { normalizeEOA } from "./address.js";
import { findRootUser } from "./bootstrap.js";
import { settlementChainReader, type SettlementChainReader } from "../settlement/chain.js";

/**
 * Binding the permanent logical referral root to the ROOT account the CONTRACT recognizes.
 *
 * There is exactly ONE logical root user and its tree position never moves. `userId`,
 * `referralCode`, `referredByUserId` and every descendant edge are untouched by a rotation; the
 * only thing that changes is which wallet that one node answers to. Rebinding is therefore an
 * O(1) write to a single document, never a tree migration.
 *
 * `ACFWithdrawal.currentRootEOA()` is the only authority. The backend holds no ROOT address of
 * its own, so there is nothing to fall out of step with and nothing to fall back to.
 */

/** Why a sync refused. Every value is an operational condition, never a transient one. */
export type RootSyncRefusal = "ROOT_EOA_COLLISION";

export class RootSyncError extends Error {
  readonly reason: RootSyncRefusal;
  constructor(reason: RootSyncRefusal, message: string) {
    super(message);
    this.name = "RootSyncError";
    this.reason = reason;
  }
}

export type RootSyncResult =
  /** No logical root exists yet; the chain root must register through the normal flow first. */
  | { status: "AWAITING_BOOTSTRAP"; chainRootEOA: string; root: null }
  /** The stored binding already matched; nothing was written. */
  | { status: "IN_SYNC"; chainRootEOA: string; root: UserDocument }
  /** The logical root was rebound from `previousEOA` to the chain's current ROOT. */
  | { status: "REBOUND"; chainRootEOA: string; previousEOA: string; root: UserDocument };

/**
 * Reads the chain, then brings the logical root's `externalEOA` into agreement with it.
 *
 * The single place root identity is ever mutated. Nothing else in the codebase writes
 * `User.externalEOA`, which is why the schema can keep it immutable for everyone.
 *
 * Fails closed in every uncertain case: an unreadable RPC propagates and a collision refuses.
 * Assigning the root to the wrong wallet is far worse than an operation that has to be retried.
 */
export async function syncLogicalRootEOAFromChain(
  reader: SettlementChainReader = settlementChainReader,
): Promise<RootSyncResult> {
  // Read the chain FIRST. If this throws, nothing has been inspected or written.
  const chainRootEOA = normalizeEOA(await reader.currentRootEOA());

  const root = await findRootUser();
  if (!root) return { status: "AWAITING_BOOTSTRAP", chainRootEOA, root: null };
  if (root.externalEOA === chainRootEOA) return { status: "IN_SYNC", chainRootEOA, root };

  const previousEOA = root.externalEOA;

  // Another user already holds the incoming address. Merging two accounts would mean choosing
  // whose referrals, positions and reward history survive, which is not a decision code should
  // make silently — and every option loses someone's money or their downline.
  // Excluding the root's OWN userId matters under concurrency: once another caller has applied
  // the rebind, the address is held by the logical root itself, which is the desired end state
  // rather than a conflict. Without this, the losing caller of a race reports a collision with
  // the very row it was trying to produce.
  const occupant = await User.findOne(
    { externalEOA: chainRootEOA, userId: { $ne: root.userId } },
    { userId: 1 },
  ).lean();
  if (occupant) {
    throw new RootSyncError(
      "ROOT_EOA_COLLISION",
      `The on-chain ROOT is ${chainRootEOA}, but user ${occupant.userId} already owns that ` +
        `address. The logical root ${root.userId} was left bound to ${previousEOA}. This needs ` +
        "manual resolution: nothing is merged, moved or overwritten automatically.",
    );
  }

  // There is deliberately NO check on what the outgoing address has already claimed.
  //
  // ACFWithdrawal keeps ONE cumulative claim watermark shared by every ROOT EOA, current and
  // historical, so `available = cumulativeInLeaf - alreadyClaimed(claimant)` continues across a
  // rotation exactly as it does for a single address: the incoming ROOT reads the figure the
  // outgoing one left behind and can only ever draw the delta above it. A rotation after one
  // claim, ten claims or years of claims is therefore just as safe as one before any.
  //
  // Compare-and-set on the OLD address, so concurrent callers cannot both apply a rebind and so a
  // binding that moved underneath us is never overwritten. `strict: false` is required because the
  // schema marks `externalEOA` immutable: that protection stays on for every ordinary write path,
  // and this one controlled site is the documented exception the spec reserves for it.
  const updated = await User.collection.findOneAndUpdate(
    { userId: root.userId, externalEOA: previousEOA, referredByUserId: null },
    { $set: { externalEOA: chainRootEOA, updatedAt: new Date() } },
    { returnDocument: "after" },
  );

  if (!updated) {
    // Another caller got there first. Re-read and accept their result rather than retrying: the
    // target value is the same for everyone, so the operation is idempotent by construction.
    const current = await findRootUser();
    if (current?.externalEOA === chainRootEOA) {
      return { status: "IN_SYNC", chainRootEOA, root: current };
    }
    throw new RootSyncError(
      "ROOT_EOA_COLLISION",
      `The logical root binding changed while syncing to ${chainRootEOA}. Nothing was written. Retry.`,
    );
  }

  // Re-read through the model, so the returned document is validated by the schema rather than
  // trusted from the driver, and so the write is confirmed rather than assumed.
  const confirmed = await findRootUser();
  if (!confirmed || confirmed.externalEOA !== chainRootEOA || confirmed.userId !== root.userId) {
    throw new RootSyncError(
      "ROOT_EOA_COLLISION",
      `Root rebind to ${chainRootEOA} did not verify on re-read. Investigate before continuing.`,
    );
  }

  return { status: "REBOUND", chainRootEOA, previousEOA, root: confirmed };
}

/**
 * The logical root, synchronized to the chain, for operations that need current root truth.
 *
 * Throws when no root exists yet, because every caller of this helper is past bootstrap.
 */
export async function requireSyncedRoot(
  reader: SettlementChainReader = settlementChainReader,
): Promise<UserDocument> {
  const result = await syncLogicalRootEOAFromChain(reader);
  if (!result.root) {
    throw new RootSyncError(
      "ROOT_EOA_COLLISION",
      `The on-chain ROOT ${result.chainRootEOA} has no user record yet. It must register first.`,
    );
  }
  return result.root;
}
