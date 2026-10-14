import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '../constants/enums';
import { cookieNamesForRequest } from '../utils/cookieUtils';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: UserRole;
  };
}

const getAccessToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.split(' ')[1] || null;
  }
  const names = cookieNamesForRequest(req);
  const cookieToken = req.cookies?.[names.ACCESS];
  return typeof cookieToken === 'string' ? cookieToken : null;
};

export const protect = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = getAccessToken(req);

  if (!token) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  try {
    const secret = process.env.JWT_SECRET || 'aarohcare_dev_secret';
    const decoded = jwt.verify(token, secret) as { id: string; role: UserRole };
    req.user = { id: decoded.id, role: decoded.role };
    return next();
  } catch {
    return res.status(401).json({ message: 'Not authorized' });
  }
};
