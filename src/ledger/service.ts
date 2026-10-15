import { DISTINCT_LOADERS } from "./sources.js";
import { LEDGER_KINDS, type LedgerKind, type LedgerPage, type LedgerRow, type LedgerTotals } from "./types.js";

/**
 * One member's history, merged from every source the protocol writes.
 *
 * Ordering is newest first by `occurredAt`, with `rowId` breaking ties. Both halves matter: a
 * settled cycle stamps every reward it produced with the SAME boundary second, so timestamp
 * alone would leave the order of those rows undefined and a page boundary could repeat or skip
 * one. `rowId` is stable and unique across sources, which makes the sequence total.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Head-room on each source's query, beyond the page itself.
 *
 * The merge asks every source for rows at or before the cursor instant, INCLUSIVE, because rows
 * sharing that second may still be unread. Those duplicates are discarded here, so each source
 * must be asked for more than the page needs. A member's rows at any one instant are bounded by
 * their own stake count, so this is generous in practice.
 */
const SAME_INSTANT_HEADROOM = 64;

export interface LedgerQuery {
  userId: string;
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  before?: string;
  /** Restrict to these kinds. Empty or omitted means every kind. */
  kinds?: LedgerKind[];
}

interface Cursor {
  occurredAt: number;
  rowId: string;
}

/** Cursors are opaque to callers, so the encoding can change without breaking them. */
export function encodeCursor(row: LedgerRow): string {
  return Buffer.from(`${row.occurredAt}|${row.rowId}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const split = text.indexOf("|");
  if (split <= 0) return null;
  const occurredAt = Number(text.slice(0, split));
  const rowId = text.slice(split + 1);
  if (!Number.isInteger(occurredAt) || occurredAt < 0 || rowId === "") return null;
  return { occurredAt, rowId };
}

/** Newest first; `rowId` descending breaks a shared instant deterministically. */
function newestFirst(a: LedgerRow, b: LedgerRow): number {
  if (a.occurredAt !== b.occurredAt) return b.occurredAt - a.occurredAt;
  return a.rowId < b.rowId ? 1 : a.rowId > b.rowId ? -1 : 0;
}

/** True when `row` sits strictly after `cursor` in the sort order — already delivered. */
function atOrBeforeCursor(row: LedgerRow, cursor: Cursor): boolean {
  if (row.occurredAt !== cursor.occurredAt) return row.occurredAt < cursor.occurredAt;
  return row.rowId < cursor.rowId;
}

export async function getLedgerPage(query: LedgerQuery): Promise<LedgerPage> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = query.before ? decodeCursor(query.before) : null;
  const wanted = new Set<LedgerKind>(
    query.kinds && query.kinds.length > 0 ? query.kinds : LEDGER_KINDS,
  );

  // Every source is asked in parallel; one slow collection should not serialise the rest.
  const perSource = limit + 1 + SAME_INSTANT_HEADROOM;
  const batches = await Promise.all(
    DISTINCT_LOADERS.map((load) =>
      load({ userId: query.userId, atOrBefore: cursor?.occurredAt, limit: perSource }),
    ),
  );

  const merged = batches
    .flat()
    .filter((row) => wanted.has(row.kind))
    .filter((row) => cursor === null || atOrBeforeCursor(row, cursor))
    .sort(newestFirst);

  const rows = merged.slice(0, limit);
  // A full page means at least one more row was available, so another page exists.
  const nextCursor =
    merged.length > limit && rows.length > 0 ? encodeCursor(rows[rows.length - 1]!) : null;

  return { rows, nextCursor };
}

/**
 * Totals across the member's WHOLE history, independent of any page or filter.
 *
 * Kept separate from the page on purpose: a summary computed from the rows currently on screen
 * would change as the reader pages, which is how a total stops meaning anything. Amounts stay in
 * base units and are summed as bigint, never as floats.
 */
export async function getLedgerTotals(userId: string): Promise<LedgerTotals> {
  const batches = await Promise.all(
    DISTINCT_LOADERS.map((load) => load({ userId, limit: Number.MAX_SAFE_INTEGER })),
  );
  const rows = batches.flat();

  let acfIn = 0n, acfOut = 0n, usdtIn = 0n, usdtOut = 0n, feesACF = 0n, feesUSDT = 0n;

  for (const row of rows) {
    // MOVE is neither: locking or releasing a member's own principal is not income or spend.
    for (const side of [row.primary, row.counter]) {
      if (!side) continue;
      const amount = BigInt(side.amount);
      const isPrimary = side === row.primary;
      // The counter side always moves opposite to the primary.
      const inward =
        row.direction === "MOVE" ? null : isPrimary ? row.direction === "IN" : row.direction !== "IN";
      if (inward === null) continue;
      if (side.unit === "ACF") inward ? (acfIn += amount) : (acfOut += amount);
      else inward ? (usdtIn += amount) : (usdtOut += amount);
    }
    if (row.fee) {
      const amount = BigInt(row.fee.amount);
      if (row.fee.unit === "ACF") feesACF += amount;
      else feesUSDT += amount;
    }
  }

  return {
    rowCount: rows.length,
    acfIn: acfIn.toString(), acfOut: acfOut.toString(),
    usdtIn: usdtIn.toString(), usdtOut: usdtOut.toString(),
    feesACF: feesACF.toString(), feesUSDT: feesUSDT.toString(),
  };
}
