import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { HttpError } from "../lib/errors.js";
import { getDAORevenueHistory, getDAORevenueSummary } from "./readModel.js";

export const daoRevenueRouter = Router();

/**
 * DAO Member Revenue for the authenticated user. Read-only.
 *
 * Kept separate from /rewards/* because DAO revenue is a direct ACF transfer, not part of the
 * Merkle claim: merging the two would invite a UI that offers to "claim" something already paid.
 */
daoRevenueRouter.get("/dao-revenue/summary", requireAuth, async (req, res, next) => {
  try {
    res.json(await getDAORevenueSummary(req.session!.sub));
  } catch (error) {
    next(error);
  }
});

/**
 * Paginated distribution history, newest first.
 *
 * Scoped to the session user; there is deliberately no userId parameter, so one member cannot
 * read another's revenue.
 */
daoRevenueRouter.get("/dao-revenue/history", requireAuth, async (req, res, next) => {
  try {
    const { limit, before } = req.query as { limit?: string; before?: string };
    const parsed: { limit?: number; before?: number } = {};
    if (limit !== undefined) {
      const value = Number(limit);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new HttpError(400, "INVALID_LIMIT", "limit must be an integer from 1 to 100.");
      }
      parsed.limit = value;
    }
    if (before !== undefined) {
      const value = Number(before);
      if (!Number.isInteger(value) || value < 0) {
        throw new HttpError(400, "INVALID_CURSOR", "before must be a non-negative integer.");
      }
      parsed.before = value;
    }
    res.json(await getDAORevenueHistory(req.session!.sub, parsed));
  } catch (error) {
    next(error);
  }
});
