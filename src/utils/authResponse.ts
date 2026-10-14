import type { Request, Response } from 'express';
import type { UserRole } from '../constants/enums';
import type { AuthResponseDto, UserResponseDto } from '../dto';
import { getClientType, isMobileClient } from './clientType';
import { setAccessCookie, setAuthCookies, setCsrfCookie, ensureCsrfCookie } from './cookieUtils';
import { accessTokenMaxAgeMs } from './jwtUtils';

type AnyRequest = Request<any, any, any, any>;

export const issueAuthSession = (
  req: AnyRequest,
  res: Response,
  args: {
    accessToken: string;
    refreshToken: string;
    user: UserResponseDto;
    status?: number;
  },
) => {
  const { accessToken, refreshToken, user, status = 200 } = args;
  const client = getClientType(req);
  setAuthCookies(res, accessToken, refreshToken, accessTokenMaxAgeMs(user.role), client);

  if (isMobileClient(req)) {
    const body: AuthResponseDto = {
      token: accessToken,
      refreshToken,
      user,
    };
    return res.status(status).json(body);
  }

  // Web: cookies only for JWTs; return CSRF in body for cross-origin SPAs.
  const csrfToken = setCsrfCookie(res, undefined, client);
  return res.status(status).json({ user, csrfToken });
};

export const issueAccessRefresh = (
  req: AnyRequest,
  res: Response,
  accessToken: string,
  role: UserRole,
  refreshToken?: string,
) => {
  const client = getClientType(req);
  setAccessCookie(res, accessToken, accessTokenMaxAgeMs(role), client);

  if (isMobileClient(req)) {
    return res.json({ token: accessToken, ...(refreshToken ? { refreshToken } : {}) });
  }

  const csrfToken = setCsrfCookie(res, undefined, client);
  return res.json({ ok: true, csrfToken });
};

export const issueCsrf = (_req: AnyRequest, res: Response) => {
  return res.json({ csrfToken: 'exempt' });
};
