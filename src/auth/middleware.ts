import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors.js";
import { verifySession, type SessionPayload } from "./jwt.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(new HttpError(401, "UNAUTHORIZED", "Missing bearer token."));
  }
  try {
    req.session = verifySession(header.slice("Bearer ".length).trim());
    next();
  } catch (error) {
    next(error);
  }
}
