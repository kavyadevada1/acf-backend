import { User } from "../models/User.js";
import { DAOReconciliationState } from "../models/DAOReconciliationState.js";

/**
 * The root of the referral tree.
 *
 * Identified by TREE POSITION — the single user with no parent — and not by wallet. The wallet a
 * root answers to can rotate on chain; its position in the tree never does. Resolving by position
 * is what makes the logical root permanent across a rotation: `userId`, `referralCode` and every
 * descendant edge stay exactly as they were, and only the `externalEOA` binding moves.
 *
 * The backend deliberately holds no ROOT address of its own. `ACFWithdrawal.currentRootEOA()` is
 * the authority for which wallet is currently bound, and `lib/rootSync.ts` is the only place that
 * binding is ever written. A configured address here could only be a stale second opinion.
 *
 * Before the on-chain ROOT registers there simply is no root. Registration by anyone else is
 * refused for exactly as long as that is true, so a user can never be created with a null parent.
 */

/** The logical root user, or null while the on-chain ROOT has not registered yet. */
export async function findRootUser() {
  return User.findOne({ referredByUserId: null });
}

/**
 * Startup check.
 *
 * Deliberately permissive: the backend STARTS whether or not the admin has registered, because
 * refusing would make the first registration impossible. The only fatal condition is a database
 * that contradicts the configuration — a parentless user who is not the configured admin means
 * the referral tree already has a different root, and continuing would silently build a second.
 */
/**
 * Fails fast on an index the application no longer declares.
 *
 * Mongoose adds new indexes but never drops old ones — deliberately, since dropping an index
 * automatically is destructive. So a schema whose uniqueness changed leaves the previous index
 * in place, where it keeps enforcing a rule the code has abandoned. That surfaces as a 500 on
 * every affected request rather than anything pointing at the cause, so it is checked here
 * instead, once, with the command to fix it.
 */
export async function assertNoStaleIndexes(): Promise<void> {
  const stale: { collection: string; index: string; reason: string }[] = [];

  const cursors = DAOReconciliationState.collection;
  const existing = await cursors.indexes().catch(() => []);
  if (existing.some((i) => i.name === "chainId_1_daoContractAddress_1")) {
    stale.push({
      collection: cursors.collectionName,
      index: "chainId_1_daoContractAddress_1",
      reason:
        "reconciliation cursors are per user now, so several documents per DAO are expected; " +
        "the old unique index rejects every user after the first",
    });
  }

  if (stale.length > 0) {
    throw new Error(
      "Stale database index(es) from an earlier schema:\n" +
        stale.map((s) => `  ${s.collection}.${s.index} — ${s.reason}`).join("\n") +
        "\n\nDrop them with:\n" +
        stale.map((s) => `  db.${s.collection}.dropIndex("${s.index}")`).join("\n") +
        `\n\nOr drop the whole ${stale[0]!.collection} collection: it is a rebuildable cache, ` +
        "not business data.",
    );
  }
}

/**
 * Startup check: the tree has at most one root.
 *
 * Deliberately says nothing about WHICH wallet that root holds. The on-chain ROOT can rotate
 * while the backend is down, so a startup comparison against the chain would refuse to boot
 * exactly when the operator needs the backend up in order to synchronize. The binding is
 * reconciled by `syncLogicalRootEOAFromChain` at the operations that depend on it instead.
 *
 * A forked tree is still fatal: two parentless users mean two roots, and continuing would keep
 * building both.
 */
export async function assertReferralRoot(): Promise<void> {
  const parentless = await User.find({ referredByUserId: null }, { userId: 1, externalEOA: 1 });
  if (parentless.length <= 1) return;

  throw new Error(
    `Found ${parentless.length} users without a parent: ` +
      `${parentless.map((u) => `${u.userId} (${u.externalEOA})`).join(", ")}. ` +
      "A referral tree has exactly one root. Refusing to start against a forked tree — " +
      "run scripts/backfill-root-parent.ts to attach the legacy ones to the real root.",
  );
}

/** Reports whether registration is currently open, for the startup log. */
export async function referralRootStatus(): Promise<"registered" | "awaiting-root"> {
  return (await findRootUser()) ? "registered" : "awaiting-root";
}
