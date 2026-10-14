import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import SuperAdmin from '../models/SuperAdmin';
import PlatformLock from '../models/PlatformLock';
import { UserRole } from '../constants/enums';
import { MSG } from '../constants/messages';
import type { ISuperAdmin } from '../types';
import type { UserResponseDto } from '../dto';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { isMailConfigured, sendPasswordResetEmail } from '../utils/mailer';
import { EMAIL_RE, MIN_PASSWORD_LEN, requireEmail, requirePassword } from '../utils/validators';
import { normalizeEmail, normalizePhone } from './authService';

const BOOTSTRAP_LOCK_KEY = 'super_admin_bootstrap';

const hashResetToken = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');

const isDuplicateKey = (error: unknown) =>
  error instanceof Error && error.message.includes('E11000');

const requireAccountFields = (body: {
  name?: string;
  email?: string;
  phone?: string;
  password?: string;
}) => {
  const { name, email, phone, password } = body;
  if (!name?.trim() || !email?.trim() || !phone?.trim() || !password) {
    throw AppError.badRequest(MSG.REQUIRED_NAME_EMAIL_PHONE_PASSWORD);
  }
  requirePassword(String(password));
  if (!EMAIL_RE.test(String(email).trim().toLowerCase())) {
    throw AppError.badRequest(MSG.INVALID_EMAIL);
  }
  return {
    name: String(name),
    email: String(email),
    phone: String(phone),
    password: String(password),
  };
};

export const toPublicSuperAdmin = (admin: ISuperAdmin): UserResponseDto => {
  const obj = admin.toObject();
  return {
    _id: String(obj._id),
    name: obj.name,
    phone: obj.phone,
    email: obj.email,
    role: UserRole.SUPER_ADMIN,
    createdAt: obj.createdAt ? new Date(obj.createdAt).toISOString() : undefined,
    updatedAt: obj.updatedAt ? new Date(obj.updatedAt).toISOString() : undefined,
  };
};

export const superAdminAccountService = {
  count: async () => SuperAdmin.countDocuments(),

  list: async () => SuperAdmin.find().select('-password').sort({ createdAt: -1 }),

  findById: async (id: string) => SuperAdmin.findById(id).select('-password'),

  findByIdWithPassword: async (id: string) => SuperAdmin.findById(id),

  findByEmail: async (email: string) =>
    SuperAdmin.findOne({ email: normalizeEmail(email) }),

  isBootstrapLocked: async () => {
    const lock = await PlatformLock.findOne({ key: BOOTSTRAP_LOCK_KEY, locked: true });
    return Boolean(lock);
  },

  /** True when bootstrap is allowed (unlocked + empty collection). */
  canBootstrap: async () => {
    if (await superAdminAccountService.isBootstrapLocked()) return false;
    return (await superAdminAccountService.count()) === 0;
  },

  lockBootstrap: async () => {
    await PlatformLock.findOneAndUpdate(
      { key: BOOTSTRAP_LOCK_KEY },
      { locked: true, lockedAt: new Date() },
      { upsert: true, new: true },
    );
  },

  create: async (data: {
    name: string;
    email: string;
    phone: string;
    password: string;
  }) => {
    const hashed = await bcrypt.hash(data.password, 10);
    return SuperAdmin.create({
      name: data.name.trim(),
      email: normalizeEmail(data.email),
      phone: normalizePhone(data.phone),
      password: hashed,
      isActive: true,
    });
  },

  /** First Super Admin + permanent bootstrap lock. */
  bootstrap: async (data: {
    name: string;
    email: string;
    phone: string;
    password: string;
  }) => {
    const admin = await superAdminAccountService.create(data);
    await superAdminAccountService.lockBootstrap();
    return admin;
  },

  bootstrapAccount: async (body: {
    name?: string;
    email?: string;
    phone?: string;
    password?: string;
  }) => {
    if (!(await superAdminAccountService.canBootstrap())) {
      throw AppError.notFound(MSG.NOT_FOUND);
    }

    const fields = requireAccountFields(body);
    try {
      const admin = await superAdminAccountService.bootstrap(fields);
      return {
        message: MSG.BOOTSTRAP_DONE,
        admin: toPublicSuperAdmin(admin),
      };
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw AppError.conflict(MSG.SUPER_ADMIN_DUP);
      }
      throw error;
    }
  },

  createAccount: async (body: {
    name?: string;
    email?: string;
    phone?: string;
    password?: string;
  }) => {
    const fields = requireAccountFields(body);

    const emailTaken = await superAdminAccountService.findByEmail(fields.email);
    if (emailTaken) {
      throw AppError.badRequest(MSG.SUPER_ADMIN_EMAIL_TAKEN);
    }

    try {
      const admin = await superAdminAccountService.create(fields);
      return {
        message: MSG.SUPER_ADMIN_CREATED,
        admin: toPublicSuperAdmin(admin),
      };
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw AppError.conflict(MSG.SUPER_ADMIN_DUP);
      }
      throw error;
    }
  },

  updateEmail: async (id: string, email: string) =>
    SuperAdmin.findByIdAndUpdate(
      id,
      { email: normalizeEmail(email) },
      { new: true },
    ).select('-password'),

  setActive: async (id: string, isActive: boolean) =>
    SuperAdmin.findByIdAndUpdate(id, { isActive }, { new: true }).select('-password'),

  changePassword: async (id: string, currentPassword: string, newPassword: string) => {
    const admin = await SuperAdmin.findById(id);
    if (!admin) return { ok: false as const, reason: 'not_found' as const };

    const valid = await bcrypt.compare(currentPassword, admin.password);
    if (!valid) return { ok: false as const, reason: 'bad_password' as const };

    admin.password = await bcrypt.hash(newPassword, 10);
    await admin.save();
    return { ok: true as const };
  },

  changeOwnPassword: async (
    id: string,
    currentPasswordRaw: string,
    newPasswordRaw: string,
  ) => {
    const currentPassword = String(currentPasswordRaw || '');
    const newPassword = String(newPasswordRaw || '');

    if (!currentPassword || !newPassword) {
      throw AppError.badRequest(MSG.REQUIRED_CURRENT_NEW_PASSWORD);
    }
    if (newPassword.length < MIN_PASSWORD_LEN) {
      throw AppError.badRequest(MSG.PASSWORD_MIN);
    }

    const result = await superAdminAccountService.changePassword(
      id,
      currentPassword,
      newPassword,
    );
    if (!result.ok && result.reason === 'not_found') {
      throw AppError.notFound(MSG.SUPER_ADMIN_NOT_FOUND);
    }
    if (!result.ok && result.reason === 'bad_password') {
      throw AppError.badRequest(MSG.CURRENT_PASSWORD_INCORRECT);
    }
    return MSG.PASSWORD_UPDATED;
  },

  changeEmail: async (id: string, email: string, currentPassword: string) => {
    const admin = await SuperAdmin.findById(id);
    if (!admin) return { ok: false as const, reason: 'not_found' as const };

    const valid = await bcrypt.compare(currentPassword, admin.password);
    if (!valid) return { ok: false as const, reason: 'bad_password' as const };

    const taken = await SuperAdmin.findOne({ email: normalizeEmail(email) });
    if (taken && String(taken._id) !== String(admin._id)) {
      return { ok: false as const, reason: 'email_taken' as const };
    }

    admin.email = normalizeEmail(email);
    await admin.save();
    const updated = await SuperAdmin.findById(id).select('-password');
    return { ok: true as const, admin: updated! };
  },

  changeOwnEmail: async (id: string, emailRaw: string, currentPasswordRaw: string) => {
    const email = String(emailRaw || '')
      .trim()
      .toLowerCase();
    const currentPassword = String(currentPasswordRaw || '');

    if (!EMAIL_RE.test(email)) {
      throw AppError.badRequest(MSG.INVALID_EMAIL);
    }
    if (!currentPassword) {
      throw AppError.badRequest(MSG.CURRENT_PASSWORD_REQUIRED_EMAIL);
    }

    const result = await superAdminAccountService.changeEmail(id, email, currentPassword);
    if (!result.ok && result.reason === 'not_found') {
      throw AppError.notFound(MSG.SUPER_ADMIN_NOT_FOUND);
    }
    if (!result.ok && result.reason === 'bad_password') {
      throw AppError.badRequest(MSG.CURRENT_PASSWORD_INCORRECT);
    }
    if (!result.ok && result.reason === 'email_taken') {
      throw AppError.badRequest(MSG.EMAIL_IN_USE);
    }

    return {
      message: MSG.EMAIL_UPDATED,
      admin: toPublicSuperAdmin(result.admin),
    };
  },

  createPasswordResetToken: async (adminId: string) => {
    const token = crypto.randomBytes(32).toString('hex');
    const hashed = hashResetToken(token);
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await SuperAdmin.findByIdAndUpdate(adminId, {
      passwordResetToken: hashed,
      passwordResetExpires: expires,
    });
    return token;
  },

  findByPasswordResetToken: async (token: string) => {
    const hashed = hashResetToken(token);
    return SuperAdmin.findOne({
      passwordResetToken: hashed,
      passwordResetExpires: { $gt: new Date() },
    });
  },

  clearPasswordReset: async (adminId: string) => {
    await SuperAdmin.findByIdAndUpdate(adminId, {
      $unset: { passwordResetToken: 1, passwordResetExpires: 1 },
    });
  },

  resetPasswordWithToken: async (token: string, password: string) => {
    const admin = await superAdminAccountService.findByPasswordResetToken(token);
    if (!admin) return null;

    admin.password = await bcrypt.hash(password, 10);
    admin.passwordResetToken = undefined;
    admin.passwordResetExpires = undefined;
    await admin.save();
    await superAdminAccountService.clearPasswordReset(String(admin._id));
    return admin;
  },

  forgotPassword: async (emailRaw: string) => {
    const email = requireEmail(String(emailRaw || ''));

    if (!isMailConfigured()) {
      logger.error('Super Admin forgot password requested but mailer is not configured');
      throw AppError.unavailable(MSG.MAIL_NOT_CONFIGURED);
    }

    const admin = await superAdminAccountService.findByEmail(email);
    if (!admin || !admin.isActive) {
      return MSG.FORGOT_SUPER_GENERIC;
    }

    const token = await superAdminAccountService.createPasswordResetToken(String(admin._id));
    const frontendUrl = (
      process.env.SUPER_ADMIN_FRONTEND_URL ||
      process.env.FRONTEND_URL ||
      'http://localhost:3001'
    ).replace(/\/$/, '');
    const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;

    try {
      await sendPasswordResetEmail({ to: email, name: admin.name, resetUrl });
    } catch (error) {
      logger.error(error);
      throw AppError.internal(MSG.MAIL_SEND_FAIL);
    }

    return MSG.FORGOT_SUPER_GENERIC;
  },

  resetPassword: async (tokenRaw: string, passwordRaw: string) => {
    const token = String(tokenRaw || '').trim();
    const password = String(passwordRaw || '');

    if (!token) {
      throw AppError.badRequest(MSG.RESET_TOKEN_REQUIRED);
    }
    if (password.length < MIN_PASSWORD_LEN) {
      throw AppError.badRequest(MSG.PASSWORD_MIN);
    }

    const admin = await superAdminAccountService.resetPasswordWithToken(token, password);
    if (!admin) {
      throw AppError.badRequest(MSG.RESET_LINK_INVALID);
    }

    return MSG.PASSWORD_UPDATED_SIGN_IN;
  },
};
