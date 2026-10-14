import { MSG } from '../constants/messages';
import { AppError } from './AppError';
import type { LocationDto } from '../dto';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MIN_PASSWORD_LEN = 6;

export const requireEmail = (email: string) => {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    throw AppError.badRequest(MSG.INVALID_EMAIL);
  }
  return normalized;
};

export const requirePassword = (password: string, message = MSG.PASSWORD_MIN) => {
  if (!password || password.length < MIN_PASSWORD_LEN) {
    throw AppError.badRequest(message);
  }
  return password;
};

export const requireNonEmpty = (value: unknown, message: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw AppError.badRequest(message);
  }
  return value.trim();
};

export const parseLocation = (
  location: unknown,
): LocationDto | undefined => {
  if (!location || typeof location !== 'object') return undefined;
  const loc = location as { lat?: unknown; lng?: unknown; formattedAddress?: unknown };
  if (
    typeof loc.lat !== 'number' ||
    typeof loc.lng !== 'number' ||
    !Number.isFinite(loc.lat) ||
    !Number.isFinite(loc.lng)
  ) {
    return undefined;
  }
  return {
    lat: loc.lat,
    lng: loc.lng,
    formattedAddress:
      typeof loc.formattedAddress === 'string' ? loc.formattedAddress : undefined,
  };
};
