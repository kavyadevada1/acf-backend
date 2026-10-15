import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeCursor, decodeCursor } from "./service.js";
import { LEDGER_KINDS } from "./types.js";
import type { LedgerRow } from "./types.js";

/**
 * Ordering and paging, which is where a merged feed goes wrong.
 *
 * Eleven sources are read independently and interleaved. A settled cycle stamps every reward it
 * produced with the same boundary second, so a great many rows legitimately share a timestamp —
 * and an order that is only defined up to the second will repeat or drop one of them at a page
 * boundary. The sort and the cursor are exercised here directly.
 */

const row = (occurredAt: number, rowId: string): LedgerRow => ({
  rowId,
  occurredAt,
  kind: "SELF_REWARD",
  direction: "IN",
  primary: { amount: "1", unit: "ACF" },
  breakdown: null,
  counter: null,
  fee: null,
  txHash: null,
  blockNumber: null,
  epochId: null,
  detail: {},
});

/** The comparator and cursor rule the service uses, exercised without a database. */
function newestFirst(a: LedgerRow, b: LedgerRow): number {
  if (a.occurredAt !== b.occurredAt) return b.occurredAt - a.occurredAt;
  return a.rowId < b.rowId ? 1 : a.rowId > b.rowId ? -1 : 0;
}

function atOrBeforeCursor(r: LedgerRow, c: { occurredAt: number; rowId: string }): boolean {
  if (r.occurredAt !== c.occurredAt) return r.occurredAt < c.occurredAt;
  return r.rowId < c.rowId;
}

/** Pages a fixed set exactly as getLedgerPage does, so the walk can be checked end to end. */
function pageThrough(all: LedgerRow[], limit: number): LedgerRow[][] {
  const pages: LedgerRow[][] = [];
  let cursor: { occurredAt: number; rowId: string } | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const merged = all
      .filter((r) => cursor === null || atOrBeforeCursor(r, cursor))
      .sort(newestFirst);
    const rows = merged.slice(0, limit);
    if (rows.length === 0) break;
    pages.push(rows);
    if (merged.length <= limit) break;
    const last = rows[rows.length - 1]!;
    cursor = { occurredAt: last.occurredAt, rowId: last.rowId };
  }
  return pages;
}

describe("ledger ordering", () => {
  it("1. newest first", () => {
    const sorted = [row(100, "a"), row(300, "b"), row(200, "c")].sort(newestFirst);
    assert.deepEqual(sorted.map((r) => r.occurredAt), [300, 200, 100]);
  });

  it("2. a shared instant is ordered by rowId, not left undefined", () => {
    // Every reward from one settled cycle carries that cycle's boundary second.
    const same = [row(500, "self:3:41461"), row(500, "self:1:41461"), row(500, "self:2:41461")];
    const sorted = [...same].sort(newestFirst);
    assert.deepEqual(
      sorted.map((r) => r.rowId),
      ["self:3:41461", "self:2:41461", "self:1:41461"],
      "descending rowId gives one definite order",
    );
    // And it is stable: sorting a different arrival order yields the same sequence.
    const reshuffled = [same[2]!, same[0]!, same[1]!].sort(newestFirst);
    assert.deepEqual(reshuffled.map((r) => r.rowId), sorted.map((r) => r.rowId));
  });
});

describe("ledger paging", () => {
  it("3. walks the whole history exactly once", () => {
    const all = [
      row(900, "claim:0xaa:0"), row(900, "dao:0xbb:1"),
      row(800, "self:1:41460"), row(800, "self:2:41460"), row(800, "level:41460"),
      row(700, "stake:7"), row(600, "swap:e1"), row(500, "bond:9"),
    ];
    const pages = pageThrough(all, 3);
    const seen = pages.flat().map((r) => r.rowId);
    assert.equal(seen.length, all.length, "no row is dropped");
    assert.equal(new Set(seen).size, all.length, "and none is repeated");
    assert.deepEqual([...seen].sort(), all.map((r) => r.rowId).sort());
  });

  it("4. a page boundary falling inside a shared instant loses nothing", () => {
    // Eight rows at one second, pages of three: the boundary lands mid-instant twice.
    const all = Array.from({ length: 8 }, (_, i) => row(1_000, `self:${i}:41461`));
    const pages = pageThrough(all, 3);
    const seen = pages.flat().map((r) => r.rowId);
    assert.equal(seen.length, 8);
    assert.equal(new Set(seen).size, 8, "the duplicate-instant boundary is handled");
  });

  it("5. paging terminates on an exhausted history", () => {
    const all = [row(10, "a"), row(9, "b")];
    const pages = pageThrough(all, 10);
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.length, 2);
  });

  it("6. an empty history yields no pages", () => {
    assert.deepEqual(pageThrough([], 25), []);
  });
});

describe("ledger cursors", () => {
  it("7. round-trip exactly, including a rowId containing separators", () => {
    const r = row(1_791_115_200, "claim:0xabc|def:3");
    const decoded = decodeCursor(encodeCursor(r));
    assert.equal(decoded?.occurredAt, 1_791_115_200);
    assert.equal(decoded?.rowId, "claim:0xabc|def:3", "only the FIRST separator splits");
  });

  it("8. malformed cursors are rejected, never silently treated as the start", () => {
    // Returning null here makes the caller's intent explicit rather than quietly restarting.
    for (const bad of ["", "!!!", Buffer.from("nopipe").toString("base64url"),
                       Buffer.from("|rowOnly").toString("base64url"),
                       Buffer.from("notanumber|x").toString("base64url"),
                       Buffer.from("12|").toString("base64url")]) {
      assert.equal(decodeCursor(bad), null, bad);
    }
  });

  it("9. the cursor is opaque — callers cannot read a timestamp out of it", () => {
    const encoded = encodeCursor(row(1_791_115_200, "self:1:41461"));
    assert.doesNotMatch(encoded, /1791115200/, "not plainly readable");
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, "URL-safe");
  });
});

describe("ledger vocabulary", () => {
  it("10. every kind is distinct and the list is closed", () => {
    assert.equal(new Set(LEDGER_KINDS).size, LEDGER_KINDS.length);
    assert.equal(LEDGER_KINDS.length, 11);
  });

  it("11. no kind implies a balance", () => {
    // The protocol has no per-member balance; a kind named for one would promise it.
    for (const kind of LEDGER_KINDS) {
      assert.doesNotMatch(kind, /BALANCE|DEPOSIT/, kind);
    }
  });
});
