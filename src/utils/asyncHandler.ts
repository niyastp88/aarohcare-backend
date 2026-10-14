import type { NextFunction, Request, Response } from 'express';

type AsyncRoute<Req extends Request = Request> = (
  req: Req,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/** Wrap async controllers so thrown AppError / errors reach error middleware. */
export const asyncHandler =
  <Req extends Request = Request>(fn: AsyncRoute<Req>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
