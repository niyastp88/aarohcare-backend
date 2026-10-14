import type { Request } from 'express';

export type ClientType = 'mobile' | 'web' | 'superadmin';

/**
 * Mobile: Bearer tokens in JSON (`X-Client: mobile`).
 * Super Admin SPA: cookies (`X-Client: superadmin`).
 * Facility web (default): cookies (`X-Client: web` or omitted).
 */
export const getClientType = (req: Request): ClientType => {
  const header = String(req.headers['x-client'] || '')
    .trim()
    .toLowerCase();
  if (header === 'mobile') return 'mobile';
  if (header === 'superadmin') return 'superadmin';
  return 'web';
};

export const isMobileClient = (req: Request) => getClientType(req) === 'mobile';
export const isSuperAdminClient = (req: Request) => getClientType(req) === 'superadmin';
