import jwt, { SignOptions } from 'jsonwebtoken';
import { UserRole } from '../constants/enums';

const getJwtSecret = () => process.env.JWT_SECRET || 'aarohcare_dev_secret';

/** Long-lived access tokens (30 days) for seamless mobile & web session. */
export const ACCESS_TOKEN_EXPIRES: SignOptions['expiresIn'] = '30d';
export const ADMIN_ACCESS_TOKEN_EXPIRES: SignOptions['expiresIn'] = '30d';
export const REFRESH_TOKEN_EXPIRES: SignOptions['expiresIn'] = '365d';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const isPortalAdminRole = (role: UserRole) =>
  role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

export const accessTokenExpiresIn = (_role: UserRole): SignOptions['expiresIn'] => '30d';

export const accessTokenMaxAgeMs = (_role: UserRole) => 30 * DAY_MS;

export const signAccessToken = (id: string, role: UserRole) =>
  jwt.sign({ id, role }, getJwtSecret(), { expiresIn: accessTokenExpiresIn(role) });

export const signRefreshToken = (id: string, role: UserRole) =>
  jwt.sign({ id, role }, getJwtSecret(), { expiresIn: REFRESH_TOKEN_EXPIRES });

export const verifyToken = (token: string) =>
  jwt.verify(token, getJwtSecret()) as { id: string; role: UserRole };


