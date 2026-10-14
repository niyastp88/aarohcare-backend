import { FacilityType, UserRole } from '../constants/enums';

/** Shared location payload used by admin registration / profile. */
export interface LocationDto {
  lat: number;
  lng: number;
  formattedAddress?: string;
}

export type FacilityApprovalStatusDto = 'PENDING' | 'APPROVED' | 'REJECTED';

/** Facility attached to ADMIN login / me so the portal can gate access. */
export interface FacilityAccessDto {
  _id: string;
  name: string;
  facilityType: FacilityType;
  approvalStatus: FacilityApprovalStatusDto;
  isActive: boolean;
}

/** Public user shape returned by the API (never includes password). */
export interface UserResponseDto {
  _id: string;
  name: string;
  phone: string;
  email?: string;
  role: UserRole;
  healthCardId?: string;
  place?: string;
  facilityType?: FacilityType;
  location?: LocationDto;
  address?: string;
  age?: number;
  dateOfBirth?: string;
  bloodGroup?: string;
  profileImage?: string;
  gender?: string;
  termsAcceptedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  facility?: FacilityAccessDto;
}

export interface ApiMessageResponseDto {
  message: string;
}

export interface ApiErrorResponseDto {
  message: string;
}
