import type { NextFunction, Request, Response } from 'express';
import { MSG } from '../constants/messages';
import { HTTP } from '../constants/httpStatus';
import { isAppError } from '../utils/AppError';
import { sendError } from '../utils/apiResponse';
import { logger } from '../utils/logger';

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (isAppError(err)) {
    return sendError(res, err.message, err.statusCode);
  }

  logger.error(err);

  if (err instanceof Error && err.message.includes('E11000')) {
    return sendError(res, MSG.EMAIL_TAKEN, HTTP.CONFLICT);
  }

  return sendError(res, MSG.INTERNAL, HTTP.INTERNAL);
};
