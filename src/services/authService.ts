import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import User from '../models/User';
import { FacilityType, UserRole } from '../constants/enums';
import { MSG } from '../constants/messages';
import type { ILocation } from '../types';
import type {
  LoginRequestDto,
  RegisterRequestDto,
  UserResponseDto,
} from '../dto';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { isMailConfigured, sendPasswordResetEmail } from '../utils/mailer';
import { EMAIL_RE, MIN_PASSWORD_LEN, requireEmail } from '../utils/validators';
import { superAdminAccountService, toPublicSuperAdmin } from './superAdminAccountService';

export const normalizePhone = (phone: string) =>
  phone.replace(/\D/g, '');

/** Last 10 digits — login accepts numbers with or without +91. */
export const toLocalPhone = (phone: string) => {
  const digits = normalizePhone(phone);
  return digits.length > 10 ? digits.slice(-10) : digits;
};

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const toPublicUser = (user: {
  toObject: () => Record<string, unknown>;
}): UserResponseDto => {
  const { password: _password, ...safe } = user.toObject();
  void _password;
  return safe as unknown as UserResponseDto;
};

const toSessionUser = async (user: {
  _id: { toString: () => string };
  role: UserRole;
  toObject: () => Record<string, unknown>;
}): Promise<UserResponseDto> => {
  const dto = toPublicUser(user);
  if (dto.role !== UserRole.ADMIN) return dto;
  const { facilityService } = await import('./facilityService');
  const facility = await facilityService.publicSummaryForOwner(String(user._id));
  return { ...dto, facility: facility ?? undefined };
};

export type AuthSessionSubject = {
  id: string;
  role: UserRole;
  user: UserResponseDto;
};

const generateHealthCardId = async (): Promise<string> => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const stamp = Date.now().toString(36).toUpperCase().slice(-4);
    const random = crypto.randomBytes(2).toString('hex').toUpperCase();
    const healthCardId = `AC${stamp}${random}`;
    const exists = await User.exists({ healthCardId });
    if (!exists) return healthCardId;
  }
  return `AC${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
};

const defaultEmailFor = (phone: string, role: UserRole) =>
  role === UserRole.ADMIN
    ? `${phone}.admin@phone.aarohcare.local`
    : `${phone}@phone.aarohcare.local`;

const hashResetToken = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');

const isDuplicateKey = (error: unknown) =>
  error instanceof Error && error.message.includes('E11000');

export const authService = {
  findById: async (id: string) => User.findById(id).select('-password'),

  findByIdWithPassword: async (id: string) => User.findById(id),

  findByPhone: async (phone: string, role?: UserRole) => {
    const filter: Record<string, unknown> = { phone: normalizePhone(phone) };
    if (role) filter.role = role;
    return User.findOne(filter);
  },

  /** Match stored phone with or without country code (e.g. 91…). */
  findByPhoneLoose: async (phone: string, role?: UserRole) => {
    const digits = normalizePhone(phone);
    const local = toLocalPhone(digits);
    const candidates = Array.from(new Set([digits, local, `91${local}`].filter(Boolean)));
    const filter: Record<string, unknown> = { phone: { $in: candidates } };
    if (role) filter.role = role;
    return User.findOne(filter);
  },

  findByEmail: async (email: string) => User.findOne({ email: normalizeEmail(email) }),

  createUser: async (data: {
    name: string;
    phone: string;
    password: string;
    role: UserRole;
    place?: string;
    age?: number;
    facilityType?: FacilityType;
    location?: ILocation;
    email?: string;
    termsAcceptedAt?: Date;
  }) => {
    const hashed = await bcrypt.hash(data.password, 10);
    const phone = normalizePhone(data.phone);
    const healthCardId = await generateHealthCardId();

    const email =
      data.email && data.email.trim()
        ? normalizeEmail(data.email)
        : data.role === UserRole.ADMIN
          ? null
          : defaultEmailFor(phone, data.role);

    if (!email) {
      throw AppError.badRequest(MSG.ADMIN_EMAIL_REQUIRED);
    }

    const user = new User({
      ...data,
      phone,
      healthCardId,
      email,
      password: hashed,
      address: data.location?.formattedAddress || data.place,
    });
    return user.save();
  },

  comparePassword: async (plain: string, hashed: string) =>
    bcrypt.compare(plain, hashed),

  hashPassword: async (plain: string) => bcrypt.hash(plain, 10),

  createPasswordResetToken: async (userId: string) => {
    const token = crypto.randomBytes(32).toString('hex');
    const hashed = hashResetToken(token);
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    await User.findByIdAndUpdate(userId, {
      passwordResetToken: hashed,
      passwordResetExpires: expires,
    });

    return token;
  },

  findByPasswordResetToken: async (token: string) => {
    const hashed = hashResetToken(token);
    return User.findOne({
      passwordResetToken: hashed,
      passwordResetExpires: { $gt: new Date() },
    });
  },

  clearPasswordReset: async (userId: string) => {
    await User.findByIdAndUpdate(userId, {
      $unset: { passwordResetToken: 1, passwordResetExpires: 1 },
    });
  },

  /** Register patient or facility admin (+ facility bootstrap for admin). */
  register: async (body: RegisterRequestDto): Promise<AuthSessionSubject> => {
    const {
      name,
      phone,
      password,
      role,
      place,
      age,
      facilityType,
      location,
      email,
      termsAcceptedAt,
    } = body;

    if (!name || !phone || !role) {
      throw AppError.badRequest(MSG.REQUIRED_NAME_PHONE_ROLE);
    }

    const normalizedPhone = normalizePhone(String(phone));
    if (normalizedPhone.length < 10) {
      throw AppError.badRequest(MSG.INVALID_PHONE);
    }

    if (!Object.values(UserRole).includes(role)) {
      throw AppError.badRequest(MSG.INVALID_ROLE);
    }

    if (role === UserRole.SUPER_ADMIN) {
      throw AppError.forbidden(MSG.SUPER_ADMIN_SELF_REGISTER);
    }

    if (role === UserRole.PATIENT && !termsAcceptedAt) {
      throw AppError.badRequest(MSG.TERMS_REQUIRED);
    }

    let resolvedTermsAcceptedAt: Date | undefined;
    if (termsAcceptedAt) {
      const parsed = new Date(termsAcceptedAt);
      if (Number.isNaN(parsed.getTime())) {
        throw AppError.badRequest(MSG.INVALID_TERMS_TS);
      }
      resolvedTermsAcceptedAt = parsed;
    }

    let normalizedEmail: string | undefined;
    if (email) {
      normalizedEmail = normalizeEmail(String(email));
      if (!EMAIL_RE.test(normalizedEmail)) {
        throw AppError.badRequest(MSG.INVALID_EMAIL);
      }
    }

    const { facilityService } = await import('./facilityService');

    if (role === UserRole.ADMIN) {
      if (!password) {
        throw AppError.badRequest(MSG.ADMIN_PASSWORD_REQUIRED);
      }
      if (!normalizedEmail) {
        throw AppError.badRequest(MSG.ADMIN_EMAIL_REQUIRED);
      }
      if (!facilityType || !Object.values(FacilityType).includes(facilityType)) {
        throw AppError.badRequest(MSG.SELECT_FACILITY_TYPE);
      }

      const existingEmailUser = await authService.findByEmail(normalizedEmail);
      if (existingEmailUser) {
        throw AppError.badRequest(MSG.EMAIL_TAKEN);
      }

      const existingFacility = await facilityService.findByPhone(normalizedPhone);
      if (existingFacility) {
        throw AppError.badRequest(MSG.FACILITY_PHONE_TAKEN);
      }
      const existingAdmin = await authService.findByPhone(normalizedPhone, UserRole.ADMIN);
      if (existingAdmin) {
        throw AppError.badRequest(MSG.FACILITY_PHONE_TAKEN);
      }
    } else {
      const existingPatient = await authService.findByPhone(
        normalizedPhone,
        UserRole.PATIENT,
      );
      if (existingPatient) {
        throw AppError.badRequest(MSG.PATIENT_PHONE_TAKEN);
      }
    }

    const hasLocation =
      location &&
      typeof location.lat === 'number' &&
      typeof location.lng === 'number' &&
      !Number.isNaN(location.lat) &&
      !Number.isNaN(location.lng);

    const resolvedPassword =
      password ||
      `Ac#${normalizedPhone.slice(-4)}${Math.floor(1000 + Math.random() * 9000)}`;

    let user: Awaited<ReturnType<typeof authService.createUser>>;
    try {
      user = await authService.createUser({
        name,
        phone: normalizedPhone,
        password: resolvedPassword,
        role,
        place,
        age: typeof age === 'number' ? age : age ? Number(age) : undefined,
        facilityType: role === UserRole.ADMIN ? facilityType : undefined,
        location: hasLocation
          ? {
              lat: location!.lat,
              lng: location!.lng,
              formattedAddress: location!.formattedAddress || place,
            }
          : undefined,
        email: normalizedEmail,
        termsAcceptedAt: resolvedTermsAcceptedAt,
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        const msg = String((error as Error).message).includes('email')
          ? MSG.EMAIL_TAKEN
          : role === UserRole.ADMIN
            ? MSG.FACILITY_PHONE_TAKEN
            : MSG.PATIENT_PHONE_TAKEN;
        throw AppError.conflict(msg);
      }
      throw error;
    }

    if (role === UserRole.ADMIN && facilityType && normalizedEmail) {
      try {
        await facilityService.createForAdmin({
          ownerId: String(user._id),
          name: user.name,
          facilityType,
          phone: user.phone,
          email: normalizedEmail,
          place: user.place,
          address: user.address,
          location: user.location,
          bankAccountDetails: body.bankAccountDetails,
          razorpayAccountId: body.razorpayAccountId,
        });
      } catch (facilityError) {
        await user.deleteOne();
        throw facilityError;
      }
    }

    return {
      id: String(user._id),
      role: user.role,
      user: await toSessionUser(user),
    };
  },

  /** Resolve credentials to a session subject (phone patient, phone+password admin, email). */
  resolveLogin: async (
    body: LoginRequestDto,
    opts: { isSuperAdminClient: boolean },
  ): Promise<AuthSessionSubject> => {
    const { phone, password, email } = body;

    if (phone) {
      const normalized = toLocalPhone(String(phone));

      if (password) {
        const admin = await authService.findByPhoneLoose(normalized, UserRole.ADMIN);
        if (!admin) {
          throw AppError.unauthorized(MSG.INVALID_CREDENTIALS);
        }
        if (admin.isActive === false) {
          throw AppError.forbidden('Your account is deactivated. Please contact support.');
        }
        const valid = await authService.comparePassword(password, admin.password);
        if (!valid) {
          throw AppError.unauthorized(MSG.INVALID_CREDENTIALS);
        }

        return {
          id: String(admin._id),
          role: admin.role,
          user: await toSessionUser(admin),
        };
      }

      const patient = await authService.findByPhoneLoose(normalized, UserRole.PATIENT);
      if (!patient) {
        throw AppError.unauthorized(MSG.NO_ACCOUNT_PHONE);
      }
      if (patient.isActive === false) {
        throw AppError.forbidden('Your account is deactivated. Please contact support.');
      }

      return {
        id: String(patient._id),
        role: patient.role,
        user: await toSessionUser(patient),
      };
    }

    if (!email || !password) {
      throw AppError.badRequest(MSG.REQUIRED_EMAIL_PASSWORD);
    }

    if (opts.isSuperAdminClient) {
      const admin = await superAdminAccountService.findByEmail(String(email));
      if (!admin || !admin.isActive) {
        throw AppError.unauthorized(MSG.INVALID_CREDENTIALS);
      }
      const validAdmin = await authService.comparePassword(password, admin.password);
      if (!validAdmin) {
        throw AppError.unauthorized(MSG.INVALID_CREDENTIALS);
      }

      return {
        id: String(admin._id),
        role: UserRole.SUPER_ADMIN,
        user: toPublicSuperAdmin(admin),
      };
    }

    const user = await authService.findByEmail(String(email));
    if (!user) {
      throw AppError.unauthorized(MSG.INVALID_CREDENTIALS);
    }

    const valid = await authService.comparePassword(password, user.password);
    if (!valid) {
      throw AppError.unauthorized(MSG.INVALID_CREDENTIALS);
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      throw AppError.forbidden(MSG.SUPER_ADMIN_PORTAL);
    }

    return {
      id: String(user._id),
      role: user.role,
      user: await toSessionUser(user),
    };
  },

  forgotPassword: async (emailRaw: string) => {
    const email = requireEmail(String(emailRaw || ''));

    if (!isMailConfigured()) {
      logger.error('Forgot password requested but Gmail mailer is not configured');
      throw AppError.unavailable(MSG.MAIL_NOT_CONFIGURED);
    }

    const user = await authService.findByEmail(email);
    if (!user || user.role !== UserRole.ADMIN) {
      return MSG.FORGOT_GENERIC;
    }

    const token = await authService.createPasswordResetToken(user.id);
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;

    try {
      await sendPasswordResetEmail({
        to: email,
        name: user.name,
        resetUrl,
      });
    } catch (error) {
      logger.error(error);
      throw AppError.internal(MSG.MAIL_SEND_FAIL);
    }

    return MSG.FORGOT_GENERIC;
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

    const user = await authService.findByPasswordResetToken(token);
    if (!user) {
      throw AppError.badRequest(MSG.RESET_LINK_INVALID);
    }

    user.password = await authService.hashPassword(password);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    await authService.clearPasswordReset(user.id);

    return MSG.PASSWORD_UPDATED_SIGN_IN;
  },

  changePassword: async (
    userId: string,
    role: UserRole,
    currentPasswordRaw: string,
    newPasswordRaw: string,
  ) => {
    const currentPassword = String(currentPasswordRaw || '');
    const newPassword = String(newPasswordRaw || '');

    if (!currentPassword || !newPassword) {
      throw AppError.badRequest(MSG.CURRENT_NEW_PASSWORD_REQUIRED);
    }
    if (newPassword.length < MIN_PASSWORD_LEN) {
      throw AppError.badRequest(MSG.PASSWORD_MIN);
    }

    if (role === UserRole.SUPER_ADMIN) {
      const admin = await superAdminAccountService.findByIdWithPassword(userId);
      if (!admin) {
        throw AppError.notFound(MSG.USER_NOT_FOUND);
      }
      const validAdmin = await authService.comparePassword(currentPassword, admin.password);
      if (!validAdmin) {
        throw AppError.badRequest(MSG.CURRENT_PASSWORD_INCORRECT);
      }
      admin.password = await authService.hashPassword(newPassword);
      await admin.save();
      return MSG.PASSWORD_UPDATED;
    }

    const user = await authService.findByIdWithPassword(userId);
    if (!user) {
      throw AppError.notFound(MSG.USER_NOT_FOUND);
    }

    const valid = await authService.comparePassword(currentPassword, user.password);
    if (!valid) {
      throw AppError.badRequest(MSG.CURRENT_PASSWORD_INCORRECT);
    }

    user.password = await authService.hashPassword(newPassword);
    await user.save();

    return MSG.PASSWORD_UPDATED;
  },

  getMeUser: async (userId: string, role: UserRole): Promise<UserResponseDto> => {
    if (role === UserRole.SUPER_ADMIN) {
      const admin = await superAdminAccountService.findById(userId);
      if (!admin) {
        throw AppError.unauthorized(MSG.NOT_AUTHORIZED);
      }
      return toPublicSuperAdmin(admin);
    }

    const user = await authService.findById(userId);
    if (!user) {
      throw AppError.unauthorized(MSG.NOT_AUTHORIZED);
    }

    return toSessionUser(user);
  },
};
