/**
 * Read-back verification for settlement's immutable rows.
 *
 * Phase 1 established that a bulk-write error cannot be trusted: a duplicate sets the error's
 * top-level code to 11000 even when other rows failed for unrelated reasons, and a row
 * rejected by schema validation is reported in no channel at all. Verified against a real
 * MongoDB. So nothing here branches on the error — rows are inserted, then read back and
 * compared field by field.
 *
 * Settlement history is immutable, so a pre-existing row that DIVERGES from what we recomputed
 * is never overwritten: it fails the checkpoint.
 */

export class SettlementRowError extends Error {
  readonly code = "SETTLEMENT_ROW_VERIFICATION";
  constructor(collection: string, problems: string[]) {
    super(
      `${collection}: ${problems.length} row(s) failed verification — ` +
        `${problems.slice(0, 10).join("; ")}. Refusing to advance the settlement checkpoint.`,
    );
    this.name = "SettlementRowError";
  }
}

/** Canonical, order-stable stringification so nested values compare exactly. */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== "_id" && k !== "__v")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${k}:${canonical(v)}`).join(",")}}`;
  }
  return String(value);
}

export function diffFields(
  expected: Record<string, unknown>,
  persisted: Record<string, unknown>,
  fields: string[],
): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const a = canonical(expected[f]);
    const b = canonical(persisted[f]);
    if (a !== b) out.push(`${f} expected ${a}, found ${b}`);
  }
  return out;
}

interface Model<TDoc> {
  insertMany(docs: unknown[], options: { ordered: boolean }): Promise<unknown>;
  find(filter: Record<string, unknown>): { lean(): Promise<TDoc[]> };
}

/** Inserts rows, then proves each landed with exactly the expected values. */
export async function persistAndVerify<TExpected extends object, TDoc extends object>(
  collection: string,
  model: Model<TDoc>,
  filter: Record<string, unknown>,
  expected: TExpected[],
  identity: (row: TExpected | TDoc) => string,
  fields: string[],
): Promise<void> {
  if (expected.length > 0) {
    try {
      await model.insertMany(expected, { ordered: false });
    } catch {
      // Deliberately swallowed; the read-back below is the only reliable signal.
    }
  }

  const persisted = await model.find(filter).lean();
  const byIdentity = new Map(persisted.map((r) => [identity(r), r]));
  const problems: string[] = [];

  for (const row of expected) {
    const key = identity(row);
    const found = byIdentity.get(key);
    if (!found) {
      problems.push(`${key} did not persist`);
      continue;
    }
    for (const m of diffFields(
      row as unknown as Record<string, unknown>,
      found as unknown as Record<string, unknown>,
      fields,
    )) {
      problems.push(`${key}: ${m}`);
    }
  }

  if (persisted.length !== expected.length) {
    problems.push(`expected ${expected.length} row(s), found ${persisted.length}`);
  }
  if (problems.length > 0) throw new SettlementRowError(collection, problems);
}
