import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { HttpError } from "../lib/errors.js";
import { getLedgerPage, getLedgerTotals, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./service.js";
import { LEDGER_KINDS, type LedgerKind } from "./types.js";

export const ledgerRouter = Router();

/**
 * Parses the `kinds` filter.
 *
 * An unknown kind is rejected rather than ignored: silently dropping it would return a page the
 * caller did not ask for, and a typo in a filter would look like an empty history.
 */
function parseKinds(raw: unknown): LedgerKind[] | undefined {
  if (raw === undefined) return undefined;
  const text = Array.isArray(raw) ? raw.join(",") : String(raw);
  const parts = text.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return undefined;

  const known = new Set<string>(LEDGER_KINDS);
  const unknown = parts.filter((p) => !known.has(p));
  if (unknown.length > 0) {
    throw new HttpError(
      400,
      "UNKNOWN_LEDGER_KIND",
      `Unrecognised ledger kind: ${unknown.join(", ")}.`,
    );
  }
  return parts as LedgerKind[];
}

/**
 * The authenticated member's value history, newest first.
 *
 * Every row is assembled from a record the protocol already wrote. There is no running balance:
 * the protocol holds no single per-member balance, and one would have to be invented.
 */
ledgerRouter.get("/ledger", requireAuth, async (req, res, next) => {
  try {
    const rawLimit = Number(req.query.limit);
    res.json(
      await getLedgerPage({
        userId: req.session!.sub,
        limit: Number.isInteger(rawLimit) ? rawLimit : DEFAULT_PAGE_SIZE,
        before: typeof req.query.before === "string" ? req.query.before : undefined,
        kinds: parseKinds(req.query.kinds),
      }),
    );
  } catch (error) {
    next(error);
  }
});

/** Lifetime totals per unit. Deliberately independent of the current page and filter. */
ledgerRouter.get("/ledger/totals", requireAuth, async (req, res, next) => {
  try {
    res.json(await getLedgerTotals(req.session!.sub));
  } catch (error) {
    next(error);
  }
});

/** The kinds a client may filter on, so it never has to hardcode the protocol's vocabulary. */
ledgerRouter.get("/ledger/kinds", requireAuth, (_req, res) => {
  res.json({ kinds: LEDGER_KINDS, maxPageSize: MAX_PAGE_SIZE, defaultPageSize: DEFAULT_PAGE_SIZE });
});
