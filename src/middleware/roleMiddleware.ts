import { Response, NextFunction } from 'express';
import { UserRole } from '../constants/enums';
import type { AuthRequest } from './authMiddleware';

/** Allows the route only for the given roles. Use after `protect`. */
export const requireRole =
  (...roles: UserRole[]) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    return next();
  };
