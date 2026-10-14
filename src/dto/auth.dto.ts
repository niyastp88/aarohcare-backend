import { FacilityType, UserRole } from '../constants/enums';
import type { LocationDto, UserResponseDto } from './common.dto';

export interface LoginRequestDto {
  phone?: string;
  email?: string;
  /** Optional for patient phone-only login. Required for admin/email login. */
  password?: string;
}

export interface RegisterRequestDto {
  name: string;
  phone: string;
  password?: string;
  role: UserRole;
  place?: string;
  age?: number;
  facilityType?: FacilityType;
  location?: LocationDto;
  email?: string;
  /** ISO timestamp when patient accepted Terms & Conditions */
  termsAcceptedAt?: string;
  bankAccountDetails?: {
    accountNumber?: string;
    ifscCode?: string;
    bankName?: string;
    accountHolderName?: string;
    upiId?: string;
    razorpayId?: string;
  };
  razorpayAccountId?: string;
}

export interface AuthResponseDto {
  /** Present for mobile (`X-Client: mobile`) only. Web uses httpOnly cookies. */
  token?: string;
  refreshToken?: string;
  user: UserResponseDto;
  /** Web CSRF double-submit token (also set as readable cookie). */
  csrfToken?: string;
}

export interface RefreshRequestDto {
  refreshToken?: string;
}

export interface RefreshResponseDto {
  /** Present for mobile only. Web refreshes the access cookie. */
  token?: string;
  ok?: boolean;
  csrfToken?: string;
}

export interface MeResponseDto {
  user: UserResponseDto;
  csrfToken?: string;
}

export interface ForgotPasswordRequestDto {
  email: string;
}

export interface ResetPasswordRequestDto {
  token: string;
  password: string;
}

export interface ChangePasswordRequestDto {
  currentPassword: string;
  newPassword: string;
}
