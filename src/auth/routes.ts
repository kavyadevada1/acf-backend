import { Router } from "express";
import { requireAuth } from "./middleware.js";
import { createChallenge, getUserById, verifyAndAuthenticate } from "./service.js";

export const authRouter = Router();

authRouter.post("/auth/challenge", async (req, res, next) => {
  try {
    res.json(await createChallenge(req.body?.externalEOA));
  } catch (error) {
    next(error);
  }
});

authRouter.post("/auth/verify", async (req, res, next) => {
  try {
    res.json(
      await verifyAndAuthenticate({
        externalEOA: req.body?.externalEOA,
        signature: req.body?.signature,
        referralCode: req.body?.referralCode,
      }),
    );
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    res.json(await getUserById(req.session!.sub));
  } catch (error) {
    next(error);
  }
});
