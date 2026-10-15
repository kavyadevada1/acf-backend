import { Router } from "express";
import { requireAuth } from "../../auth/middleware.js";
import { HttpError } from "../../lib/errors.js";
import { getRankHistory, getRankReadModel } from "./readModel.js";

export const rankRouter = Router();

/**
 * The authenticated user's rank, as Phase 2 calculated it for the latest settled epoch.
 *
 * Read-only, and scoped to the session: there is no userId parameter, so one member cannot read
 * another's standing.
 */
rankRouter.get("/rewards/rank", requireAuth, async (req, res, next) => {
  try {
    res.json(await getRankReadModel(req.session!.sub));
  } catch (error) {
    next(error);
  }
});

/** Rank changes, newest first. Paginated because rank is not monotonic and may oscillate. */
rankRouter.get("/rewards/rank/history", requireAuth, async (req, res, next) => {
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
    res.json(await getRankHistory(req.session!.sub, parsed));
  } catch (error) {
    next(error);
  }
});
