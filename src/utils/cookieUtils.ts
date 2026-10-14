import type { CookieOptions, Request, Response } from 'express';
import crypto from 'crypto';
import { getClientType, type ClientType } from './clientType';

/** Facility admin + patient web cookie session. */
export const AUTH_COOKIE = {
  ACCESS: 'aarohcare_access',
  REFRESH: 'aarohcare_refresh',
  /** Readable by JS for double-submit CSRF (not httpOnly). */
  CSRF: 'aarohcare_csrf',
} as const;

/** Super Admin portal — separate names so it does not clobber facility-admin sessions. */
export const SUPERADMIN_AUTH_COOKIE = {
  ACCESS: 'aarohcare_sa_access',
  REFRESH: 'aarohcare_sa_refresh',
  CSRF: 'aarohcare_sa_csrf',
} as const;

export type AuthCookieNames = {
  ACCESS: string;
  REFRESH: string;
  CSRF: string;
};

export const CSRF_HEADER = 'x-csrf-token';

const DEFAULT_ACCESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const REFRESH_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 365d
const CSRF_MAX_AGE_MS = REFRESH_MAX_AGE_MS;

/** Auth JWTs only go to API routes. */
const AUTH_COOKIE_PATH = '/api';
/** CSRF must be readable on the SPA document (Path=/). */
const CSRF_COOKIE_PATH = '/';

const useSecureCookies = () => {
  if (process.env.NODE_ENV === 'development') return false;
  return process.env.COOKIE_SECURE !== 'false';
};

const sameSitePolicy = (): CookieOptions['sameSite'] => {
  const raw = (process.env.COOKIE_SAMESITE || '').toLowerCase();
  if (raw === 'none' || raw === 'lax' || raw === 'strict') return raw;
  return useSecureCookies() ? 'none' : 'lax';
};

const baseAuthCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: useSecureCookies(),
  sameSite: sameSitePolicy(),
  path: AUTH_COOKIE_PATH,
});

const baseCsrfCookieOptions = (): CookieOptions => ({
  httpOnly: false,
  secure: useSecureCookies(),
  sameSite: sameSitePolicy(),
  path: CSRF_COOKIE_PATH,
});

export const createCsrfToken = () => crypto.randomBytes(32).toString('hex');

export const cookieNamesForClient = (client: ClientType): AuthCookieNames =>
  client === 'superadmin' ? SUPERADMIN_AUTH_COOKIE : AUTH_COOKIE;

export const cookieNamesForRequest = (req: Request): AuthCookieNames =>
  cookieNamesForClient(getClientType(req));

export const setCsrfCookie = (
  res: Response,
  token = createCsrfToken(),
  client: ClientType = 'web',
) => {
  const names = cookieNamesForClient(client);
  res.cookie(names.CSRF, token, {
    ...baseCsrfCookieOptions(),
    maxAge: CSRF_MAX_AGE_MS,
  });
  return token;
};

/** Reuse existing CSRF cookie when present so concurrent /me calls do not race mutations. */
export const ensureCsrfCookie = (req: Request, res: Response) => {
  const client = getClientType(req);
  const names = cookieNamesForClient(client);
  const existing =
    typeof req.cookies?.[names.CSRF] === 'string' ? String(req.cookies[names.CSRF]).trim() : '';
  if (existing) return existing;
  return setCsrfCookie(res, createCsrfToken(), client);
};

export const setAuthCookies = (
  res: Response,
  accessToken: string,
  refreshToken: string,
  accessMaxAgeMs = DEFAULT_ACCESS_MAX_AGE_MS,
  client: ClientType = 'web',
) => {
  const names = cookieNamesForClient(client);
  const base = baseAuthCookieOptions();
  res.cookie(names.ACCESS, accessToken, {
    ...base,
    maxAge: accessMaxAgeMs,
  });
  res.cookie(names.REFRESH, refreshToken, {
    ...base,
    maxAge: REFRESH_MAX_AGE_MS,
  });
  setCsrfCookie(res, createCsrfToken(), client);
};

export const setAccessCookie = (
  res: Response,
  accessToken: string,
  accessMaxAgeMs = DEFAULT_ACCESS_MAX_AGE_MS,
  client: ClientType = 'web',
) => {
  const names = cookieNamesForClient(client);
  res.cookie(names.ACCESS, accessToken, {
    ...baseAuthCookieOptions(),
    maxAge: accessMaxAgeMs,
  });
  setCsrfCookie(res, createCsrfToken(), client);
};

export const clearAuthCookies = (res: Response, client: ClientType = 'web') => {
  const names = cookieNamesForClient(client);
  const auth = baseAuthCookieOptions();
  const csrf = baseCsrfCookieOptions();
  res.clearCookie(names.ACCESS, auth);
  res.clearCookie(names.REFRESH, auth);
  res.clearCookie(names.CSRF, csrf);
  // Also clear legacy Path=/ auth cookies from earlier builds.
  res.clearCookie(names.ACCESS, { ...auth, path: '/' });
  res.clearCookie(names.REFRESH, { ...auth, path: '/' });
};

/** Clear both portal cookie sets (logout / emergency cleanup). */
export const clearAllPortalAuthCookies = (res: Response) => {
  clearAuthCookies(res, 'web');
  clearAuthCookies(res, 'superadmin');
};
