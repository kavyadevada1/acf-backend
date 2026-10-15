import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { getDAOMembership, listDAOContributions, recordDAOContribution } from "./service.js";

export const daoRouter = Router();

/** Records a DAO contribution. The body carries a transaction hash and nothing else. */
daoRouter.post("/dao/sync", requireAuth, async (req, res, next) => {
  try {
    res.json(await recordDAOContribution(req.session!.sub, req.body?.txHash));
  } catch (error) {
    next(error);
  }
});

daoRouter.get("/dao/contributions", requireAuth, async (req, res, next) => {
  try {
    res.json(await listDAOContributions(req.session!.sub));
  } catch (error) {
    next(error);
  }
});

daoRouter.get("/dao/membership", requireAuth, async (req, res, next) => {
  try {
    res.json(await getDAOMembership(req.session!.sub));
  } catch (error) {
    next(error);
  }
});
