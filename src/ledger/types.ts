/**
 * One movement of value for one member.
 *
 * Assembled from the records the protocol already writes — swaps, bond purchases, stakes,
 * calculated rewards, claims and DAO revenue — rather than from a ledger of its own. Nothing here
 * is derived or estimated: every row points at a document that exists, and every amount is the
 * one that document stores.
 *
 * There is deliberately NO running balance. The protocol holds no single balance per member:
 * value sits in on-chain token balances, in locked stake principal and in unclaimed rewards —
 * three different quantities in two different units. A "balance after" column would require
 * inventing a definition and replaying history against it, which is exactly the kind of figure
 * this codebase refuses to show.
 */

export type LedgerKind =
  | "SWAP_BUY"
  | "SWAP_SELL"
  | "BOND_PURCHASE"
  | "STAKE_OPENED"
  | "STAKE_CLOSED"
  | "SELF_REWARD"
  | "LEVEL_REWARD"
  | "RANK_REWARD"
  | "GLOBAL_REWARD"
  | "REWARD_CLAIM"
  | "DAO_REVENUE";

export const LEDGER_KINDS: readonly LedgerKind[] = [
  "SWAP_BUY", "SWAP_SELL", "BOND_PURCHASE", "STAKE_OPENED", "STAKE_CLOSED",
  "SELF_REWARD", "LEVEL_REWARD", "RANK_REWARD", "GLOBAL_REWARD",
  "REWARD_CLAIM", "DAO_REVENUE",
];

export type LedgerUnit = "ACF" | "USDT";

/**
 * Which way value moved, from the member's side.
 *
 * MOVE covers a transfer between the member's own positions — opening a stake locks ACF without
 * spending it, and closing one releases it. Calling either a credit or a debit would misstate it.
 */
export type LedgerDirection = "IN" | "OUT" | "MOVE";

export interface LedgerAmount {
  amount: string;
  unit: LedgerUnit;
}

/** One contributor to a row that stands for several records. */
export interface LedgerBreakdownItem {
  label: string;
  amount: LedgerAmount;
}

export interface LedgerRow {
  /**
   * Stable and unique across every source, e.g. "swap:<eventId>" or "self:<stakeId>:<epochId>".
   * Doubles as the sort tiebreaker, so a page boundary cannot repeat or skip a row when several
   * share a timestamp.
   */
  rowId: string;
  /** Unix SECONDS. Normalised here because the sources store Date and Number alike. */
  occurredAt: number;
  kind: LedgerKind;
  direction: LedgerDirection;
  /** What the row is principally about, in that record's own units. */
  primary: LedgerAmount;
  /** The other side of a two-sided movement: USDT paid for ACF bought, and so on. */
  counter: LedgerAmount | null;
  /** Protocol fee charged on this movement, where one was. */
  fee: LedgerAmount | null;
  /**
   * The transaction that proves it, or null for a reward the protocol CALCULATED. A calculated
   * reward is real but has no transaction of its own until it is claimed — saying null is the
   * honest answer, and the UI must not imply a link that does not exist.
   */
  txHash: string | null;
  blockNumber: number | null;
  /** The settlement cycle a calculated row belongs to. Null for on-chain movements. */
  epochId: number | null;
  /** Extra facts worth showing in a detail view. Strings and numbers only, never money. */
  detail: Record<string, string | number | boolean | null>;
  /**
   * The records this row stands for, when it stands for more than one.
   *
   * Self reward is calculated PER STAKE per cycle, so a member with five stakes earns five
   * entries every twelve hours — all at the same instant, four of them often dust. Presented as
   * five rows that is noise, and it reads like someone else's history mixed in.
   *
   * The row therefore carries the cycle's total and lists its parts here. Nothing is hidden and
   * nothing is rounded away: the total is the exact sum of the parts, taken as bigint.
   */
  breakdown: LedgerBreakdownItem[] | null;
}

export interface LedgerPage {
  rows: LedgerRow[];
  /** Pass back as `before` to continue. Null at the end of the history. */
  nextCursor: string | null;
}

/** Totals over the WHOLE history, per unit, so they never disagree with a filtered page. */
export interface LedgerTotals {
  rowCount: number;
  acfIn: string;
  acfOut: string;
  usdtIn: string;
  usdtOut: string;
  feesACF: string;
  feesUSDT: string;
}
