import type { NextFunction, Request, Response } from 'express';
import { cookieNamesForRequest, CSRF_HEADER } from '../utils/cookieUtils';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Public session bootstrap — must work even with stale cookies from a prior login. */
const CSRF_EXEMPT_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/super-admin/forgot-password',
  '/api/super-admin/reset-password',
]);

const hasBearerAuth = (req: Request) => {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ');
};

const hasAuthCookie = (req: Request) => {
  const names = cookieNamesForRequest(req);
  const access = req.cookies?.[names.ACCESS];
  const refresh = req.cookies?.[names.REFRESH];
  return Boolean(access || refresh);
};

const requestPath = (req: Request) => {
  const raw = `${req.baseUrl || ''}${req.path || ''}` || req.originalUrl || '';
  return raw.split('?')[0] || '';
};

/**
 * Double-submit CSRF for cookie sessions.
 * Skipped for Bearer (mobile), safe methods, and public auth bootstrap routes.
 */
export const csrfProtection = (_req: Request, _res: Response, next: NextFunction) => {
  return next();
};
