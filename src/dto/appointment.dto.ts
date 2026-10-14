import { AppointmentStatus } from '../constants/enums';
import type { UserResponseDto } from './common.dto';

export interface BookAppointmentRequestDto {
  doctorId: string;
  date: string;
  time: string;
  consultationFee?: number;
}

export interface UpdateAppointmentStatusRequestDto {
  status: AppointmentStatus;
  refundPhone?: string;
  refunded?: boolean;
  refundAmount?: number;
}

export interface CancelAppointmentRequestDto {
  /** 10-digit Indian mobile number for refund. */
  refundPhone: string;
}

export interface AppointmentCancellationDto {
  requestedAt: string;
  cancelledBy: 'PATIENT' | 'ADMIN';
  refundPhone?: string;
  policyAgreedAt?: string;
  within30Minutes?: boolean;
  refundPolicy?:
    | 'FULL_OP_NO_CONVENIENCE'
    | 'PARTIAL_90_NO_CONVENIENCE'
    | 'FULL_OP_100'
    | 'PARTIAL_90'
    | 'PARTIAL_75'
    | 'PARTIAL_50'
    | 'LAPSED_0';
  refundAmount?: number;
  refunded?: boolean;
  reason?: string;
}

export interface AppointmentResponseDto {
  _id: string;
  doctorId: string | UserResponseDto;
  patientId: string | UserResponseDto;
  date: string;
  time: string;
  status: AppointmentStatus;
  tokenNumber?: string;
  consultationFee?: number;
  consultationFeeAtBooking?: number;
  platformFee?: number;
  scheduleEndTime?: string;
  /** True when the doctor's schedule for this date is closed (no new bookings). */
  scheduleIsClosed?: boolean;
  arrivedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  cancellation?: AppointmentCancellationDto;
  createdAt?: string;
  updatedAt?: string;
}
