/**
 * Read-back verification for Phase 2's immutable rows.
 *
 * Phase 1 taught that a bulk-write error cannot be trusted: a duplicate sets the error's
 * top-level code to 11000 even when other rows failed for unrelated reasons, and a
 * validation-rejected row is reported in no channel at all. Verified against a real MongoDB.
 *
 * So nothing here branches on the error. Rows are inserted, then read back and compared FIELD
 * BY FIELD against what was recomputed. Because every Phase 2 input is historical and
 * immutable, a pre-existing row from an earlier attempt must match exactly; if it does not,
 * something is wrong that must stop the epoch rather than be overwritten or kept.
 */

export class RowVerificationError extends Error {
  readonly code = "ROW_VERIFICATION_FAILED";
  constructor(collection: string, problems: string[]) {
    super(
      `${collection}: ${problems.length} row(s) failed verification — ` +
        `${problems.slice(0, 10).join("; ")}. Refusing to mark the Team Reward epoch ` +
        "calculated.",
    );
    this.name = "RowVerificationError";
  }
}

export interface VerifiableModel<TDoc> {
  insertMany(docs: unknown[], options: { ordered: boolean }): Promise<unknown>;
  find(filter: Record<string, unknown>): { lean(): Promise<TDoc[]> };
}

/**
 * Inserts rows, then proves each one landed with exactly the expected values.
 *
 * `identity` must produce a stable key from both an expected row and a persisted one.
 * `compare` lists the fields that must agree; any difference is reported, never repaired.
 */
export async function persistAndVerify<TExpected extends object, TDoc extends object>(
  collection: string,
  model: VerifiableModel<TDoc>,
  filter: Record<string, unknown>,
  expected: TExpected[],
  identity: (row: TExpected | TDoc) => string,
  compare: (expectedRow: TExpected, persisted: TDoc) => string[],
): Promise<void> {
  if (expected.length > 0) {
    try {
      await model.insertMany(expected, { ordered: false });
    } catch {
      // Deliberately swallowed. The read-back below is the only reliable signal.
    }
  }

  const persisted = await model.find(filter).lean();
  const byIdentity = new Map(persisted.map((row) => [identity(row), row]));
  const problems: string[] = [];

  for (const row of expected) {
    const key = identity(row);
    const found = byIdentity.get(key);
    if (!found) {
      problems.push(`${key} did not persist`);
      continue;
    }
    for (const mismatch of compare(row, found)) {
      problems.push(`${key}: ${mismatch}`);
    }
  }

  if (persisted.length !== expected.length) {
    problems.push(`expected ${expected.length} row(s), found ${persisted.length}`);
  }

  if (problems.length > 0) throw new RowVerificationError(collection, problems);
}

/**
 * A canonical string for any value, so comparison is exact and order-stable.
 *
 * `String(obj)` yields "[object Object]" for every object, which would compare two different
 * audit records as equal — the gap this replaces. Object keys are SORTED so JavaScript's
 * iteration order and Mongoose's field order cannot create a false divergence, while arrays
 * keep their order, because perLevel's ordering is semantically meaningful (it is sorted by
 * level when built).
 *
 * Mongo's own bookkeeping (`_id`, `__v`) is dropped: it exists on a persisted row and never on
 * a recomputed one. Everything else is included, so a missing field, an added field and a
 * changed value are all detected.
 */
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

/**
 * Field-by-field comparison: returns a description for every disagreement.
 *
 * Nested audit objects and arrays go through `canonical`, so a divergence buried inside
 * rankAudit or levelAudit.perLevel is caught rather than compared as "[object Object]".
 */
export function diffFields(
  expected: Record<string, unknown>,
  persisted: Record<string, unknown>,
  fields: string[],
): string[] {
  const out: string[] = [];
  for (const field of fields) {
    const a = canonical(expected[field]);
    const b = canonical(persisted[field]);
    if (a !== b) out.push(`${field} expected ${a}, found ${b}`);
  }
  return out;
}
