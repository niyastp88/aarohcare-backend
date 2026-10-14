import { Document, Types } from 'mongoose';
import {
  AdMediaType,
  AdPlacement,
  AdStatus,
  AdType,
  AppointmentStatus,
  EmergencyPriority,
  EmergencyReplyFrom,
  EmergencyTicketChannel,
  EmergencyTicketSource,
  EmergencyTicketStatus,
  NotificationType,
  FacilityApprovalStatus,
  FacilityType,
  PaymentStatus,
  UserRole,
} from '../constants/enums';

export interface ILocation {
  lat: number;
  lng: number;
  formattedAddress?: string;
}

export interface IUser extends Document {
  name: string;
  email?: string;
  password: string;
  role: UserRole;
  phone: string;
  /** Unique public patient identifier for health card / future lookups. */
  healthCardId?: string;
  place?: string;
  facilityType?: FacilityType;
  location?: ILocation;
  age?: number;
  dateOfBirth?: string;
  bloodGroup?: string;
  profileImage?: string;
  address?: string;
  gender?: string;
  /** When the user accepted Terms & Conditions (patient registration). */
  termsAcceptedAt?: Date;
  /** Soft-block flag (Super Admin). */
  isActive?: boolean;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Platform operators — separate collection from facility/patient Users. */
export interface ISuperAdmin extends Document {
  name: string;
  email: string;
  phone: string;
  password: string;
  isActive: boolean;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type WeekDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface IWorkingHours {
  from: string;
  to: string;
  is24Hours?: boolean;
}

export interface IFacility extends Document {
  name: string;
  facilityType: FacilityType;
  ownerId: Types.ObjectId;
  phone: string;
  /** Professional contact email from admin registration (also stored on User for login). */
  email?: string;
  place?: string;
  address?: string;
  location?: ILocation;
  /** Public photo URL shown on patient hospital/clinic/lab lists. */
  image?: string;
  workingHours?: IWorkingHours;
  openDays?: WeekDay[];
  /** Last global staff alert posted from Settings. */
  globalAlert?: string;
  razorpayAccountId?: string;
  razorpayLinked?: boolean;
  bankAccountDetails?: {
    accountNumber?: string;
    ifscCode?: string;
    bankName?: string;
    accountHolderName?: string;
    upiId?: string;
    razorpayId?: string;
  };
  isActive: boolean;
  /** Super Admin registration review. Existing facilities default to APPROVED. */
  approvalStatus: FacilityApprovalStatus;
  /** Admin password stored for Super Admin viewing and editing */
  adminPassword?: string;
  // Store a separate convenience fee for this specific facility
  convenienceFeeOverride?: number;
  /** Manual payment status overrides for specific months (format: YYYY-MM). */
  manualPaymentStatuses?: { monthYear: string; status: 'PAID' | 'NOT_PAID' }[];
  /** Configurable cancellation policy for this facility */
  cancellationPolicy?: ICancellationPolicy;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CancellationTimeUnit = 'minutes' | 'hours' | 'days';
export type RefundProcessingUnit = 'working_days' | 'days' | 'hours';

export interface ICancellationPolicyItem {
  _id?: string;
  icon: string;
  text: {
    en: string;
    ml: string;
  };
}

export interface ICancellationPolicy {
  fullRefundWindow: {
    value: number;
    unit: CancellationTimeUnit;
  };
  afterPeriodRefundPercent: number;
  refundProcessingPeriod: {
    value: number;
    unit: RefundProcessingUnit;
  };
  additionalItems?: ICancellationPolicyItem[];
}

/** Doctor is a facility record managed by an ADMIN — not a login account. */
export interface IDoctor extends Document {
  name: string;
  specialization?: string;
  phone?: string;
  email?: string;
  qualifications?: string;
  consultationFee?: number;
  place?: string;
  profileImage?: string;
  isActive: boolean;
  adminId: Types.ObjectId;
  facilityId?: Types.ObjectId;
  /** Current live OP being served at the counter. */
  liveOp?: {
    date: string;
    currentNumber: number;
    onBreak?: boolean;
  };
  bankAccountDetails?: {
    accountNumber?: string;
    ifscCode?: string;
    bankName?: string;
    accountHolderName?: string;
    upiId?: string;
  };
}

export type AppointmentCancelledBy = 'PATIENT' | 'ADMIN';

/** Snapshot stored when a booking is cancelled — for refunds / admin review. */
export interface IAppointmentCancellation {
  requestedAt: Date;
  cancelledBy: AppointmentCancelledBy;
  /** Mobile number where refund should be sent (UPI / wallet linked). */
  refundPhone?: string;
  /** UPI ID where refund should be sent directly. */
  refundUpiId?: string;
  policyAgreedAt?: Date;
  /** True if cancel was within 30 minutes of booking (full OP refund policy). */
  within30Minutes?: boolean;
  /** Policy band applied at cancel time. */
  refundPolicy?:
    | 'FULL_OP_NO_CONVENIENCE'
    | 'PARTIAL_90_NO_CONVENIENCE'
    | 'FULL_OP_100'
    | 'PARTIAL_90'
    | 'PARTIAL_75'
    | 'PARTIAL_50'
    | 'LAPSED_0';
  /** OP fee amount owed back (convenience/platform fee excluded). */
  refundAmount?: number;
  /** Admin-confirmed whether money was already refunded. */
  refunded?: boolean;
  /** Reason for cancellation, e.g. PATIENT_NOT_ARRIVED */
  reason?: string;
  /** True if broadcast notification was already sent to affected session app users */
  cancellationNotified?: boolean;
}

export interface IAppointment extends Document {
  doctorId: IDoctor['_id'];
  patientId?: IUser['_id'] | null;
  patientName?: string;
  patientAge?: number;
  patientPhone?: string;
  date: string;
  time: string;
  status: AppointmentStatus;
  tokenNumber?: string;
  consultationFee?: number;
  /** Historical consultation fee snapshot established at booking time */
  consultationFeeAtBooking?: number;
  platformFee?: number;
  paymentStatus?: PaymentStatus;
  previousPaymentStatus?: PaymentStatus;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  cashfreeOrderId?: string;
  paymentSessionId?: string;
  /** Copied from schedule at booking — used for Your OP grace window. */
  scheduleEndTime?: string;
  /** Set when the patient is marked arrived at the facility. */
  arrivedAt?: Date;
  /** Set the first time status becomes COMPLETED. */
  completedAt?: Date;
  /** When the appointment was cancelled. */
  cancelledAt?: Date;
  /** Optional cancellation reason summary */
  cancellationReason?: string;
  /** Full cancel request details for admin refund workflow. */
  cancellation?: IAppointmentCancellation;
  /** Flag to prevent duplicate session cancellation broadcasts */
  cancellationNotified?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISchedule extends Document {
  doctorId: IDoctor['_id'];
  date: string;
  startTime?: string;
  endTime?: string;
  slots: Array<{
    time: string;
    isBooked: boolean;
  }>;
  maxTokens?: number;
  isClosed?: boolean;
}

export interface IAd extends Document {
  name: string;
  shareDetails?: string;
  redirectUrl?: string;
  imageUrl?: string;
  videoUrl?: string;
  mediaType: AdMediaType;
  adType: AdType;
  placement: AdPlacement;
  targetLocation?: string;
  objectPosition?: string;
  aspectRatio?: string;
  displaySeconds: number;
  autoRestart: boolean;
  durationDays: number;
  startsAt: Date;
  endsAt: Date;
  status: AdStatus;
  sortOrder: number;
  viewCount: number;
  totalViewTimeMs: number;
  linkClickCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IEmergencyTicket extends Document {
  subject: string;
  body: string;
  priority: EmergencyPriority;
  status: EmergencyTicketStatus;
  source: EmergencyTicketSource;
  channel: EmergencyTicketChannel;
  rating?: number;
  facilityId?: Types.ObjectId;
  city?: string;
  createdBy: Types.ObjectId;
  replies: Array<{
    body: string;
    authorId: Types.ObjectId;
    fromRole?: EmergencyReplyFrom;
    createdAt: Date;
  }>;
  resolvedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface INotification extends Document {
  userId: Types.ObjectId;
  title: string;
  body: string;
  type: NotificationType;
  ticketId?: Types.ObjectId;
  /** Dedup / deep-link key (e.g. lab-reminder:patientId:facilityId). */
  refId?: string;
  read: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ILabReport extends Document {
  facilityId: Types.ObjectId;
  patientId: Types.ObjectId;
  title: string;
  reportUrl?: string;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
