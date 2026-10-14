import { Request, Response } from 'express';
import { authService } from '../services/authService';
import { signAccessToken, signRefreshToken, verifyToken } from '../utils/jwtUtils';
import {
  clearAuthCookies,
  cookieNamesForRequest,
  ensureCsrfCookie,
} from '../utils/cookieUtils';
import { getClientType } from '../utils/clientType';
import { issueAccessRefresh, issueAuthSession, issueCsrf } from '../utils/authResponse';
import type { AuthRequest } from '../middleware/authMiddleware';
import type {
  AuthResponseDto,
  ForgotPasswordRequestDto,
  LoginRequestDto,
  MeResponseDto,
  RefreshRequestDto,
  RefreshResponseDto,
  RegisterRequestDto,
  ResetPasswordRequestDto,
} from '../dto';
import { isSuperAdminClient } from '../utils/clientType';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { sendMessage } from '../utils/apiResponse';

export const register = asyncHandler(
  async (req: Request<object, AuthResponseDto, RegisterRequestDto>, res) => {
    const subject = await authService.register(req.body);
    const token = signAccessToken(subject.id, subject.role);
    const refreshToken = signRefreshToken(subject.id, subject.role);
    return issueAuthSession(req, res, {
      accessToken: token,
      refreshToken,
      user: subject.user,
      status: 201,
    });
  },
);

export const login = asyncHandler(
  async (req: Request<object, AuthResponseDto, LoginRequestDto>, res) => {
    const subject = await authService.resolveLogin(req.body, {
      isSuperAdminClient: isSuperAdminClient(req as Request),
    });
    const token = signAccessToken(subject.id, subject.role);
    const refreshToken = signRefreshToken(subject.id, subject.role);
    return issueAuthSession(req, res, {
      accessToken: token,
      refreshToken,
      user: subject.user,
    });
  },
);

export const forgotPassword = asyncHandler(
  async (req: Request<object, { message: string }, ForgotPasswordRequestDto>, res) => {
    const message = await authService.forgotPassword(String(req.body?.email || ''));
    return sendMessage(res, message);
  },
);

export const resetPassword = asyncHandler(
  async (req: Request<object, { message: string }, ResetPasswordRequestDto>, res) => {
    const message = await authService.resetPassword(
      String(req.body?.token || ''),
      String(req.body?.password || ''),
    );
    return sendMessage(res, message);
  },
);

export const changePassword = asyncHandler(async (req: AuthRequest, res) => {
  const message = await authService.changePassword(
    req.user!.id,
    req.user!.role,
    String(req.body?.currentPassword || ''),
    String(req.body?.newPassword || ''),
  );
  return sendMessage(res, message);
});

export const refresh = asyncHandler(
  async (req: Request<Record<string, string>, RefreshResponseDto, RefreshRequestDto>, res) => {
    const names = cookieNamesForRequest(req);
    const refreshToken =
      (typeof req.body?.refreshToken === 'string' && req.body.refreshToken) ||
      (typeof req.cookies?.[names.REFRESH] === 'string' && req.cookies[names.REFRESH]) ||
      (typeof req.cookies?.aarohcare_sa_refresh === 'string' && req.cookies.aarohcare_sa_refresh) ||
      (typeof req.cookies?.aarohcare_refresh === 'string' && req.cookies.aarohcare_refresh);

    if (!refreshToken) {
      throw AppError.badRequest(MSG.REFRESH_TOKEN_REQUIRED);
    }

    try {
      const decoded = verifyToken(refreshToken);
      const token = signAccessToken(decoded.id, decoded.role);
      const newRefreshToken = signRefreshToken(decoded.id, decoded.role);
      return issueAccessRefresh(req, res, token, decoded.role, newRefreshToken);
    } catch {
      throw AppError.unauthorized(MSG.INVALID_REFRESH_TOKEN);
    }
  },
);

export const csrf = (req: Request, res: Response) => issueCsrf(req, res);

export const me = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) {
    throw AppError.unauthorized(MSG.NOT_AUTHORIZED);
  }

  const user = await authService.getMeUser(req.user.id, req.user.role);
  const csrfToken = ensureCsrfCookie(req, res);
  const body: MeResponseDto = { user, csrfToken };
  return res.json(body);
});

export const logout = asyncHandler(async (req: Request, res) => {
  clearAuthCookies(res, getClientType(req));
  return sendMessage(res, MSG.LOGGED_OUT);
});
