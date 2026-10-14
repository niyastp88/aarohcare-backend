export enum UserRole {
  PATIENT = 'PATIENT',
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum FacilityType {
  HOSPITAL = 'HOSPITAL',
  CLINIC = 'CLINIC',
  LAB = 'LAB',
}

export enum FacilityApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum AppointmentStatus {
  PENDING = 'PENDING',
  CONSULTING = 'CONSULTING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum PaymentStatus {
  NOT_PAID = 'NOT_PAID',
  PAID = 'PAID',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

export enum AdStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  BLANK = 'BLANK',
}

export enum AdMediaType {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
}

export enum AdType {
  SPONSORED = 'SPONSORED',
  PROMOTIONAL = 'PROMOTIONAL',
  INTERNAL = 'INTERNAL',
}

export enum AdPlacement {
  HOME = 'HOME',
  CLINIC_LIST = 'CLINIC_LIST',
  LAB_LIST = 'LAB_LIST',
}

/** Home ad card aspect ratio presets for creative testing. */
export enum AdAspectRatio {
  RATIO_4_3 = '4:3',
  RATIO_16_9 = '16:9',
  RATIO_1_1 = '1:1',
  RATIO_3_2 = '3:2',
  RATIO_5_4 = '5:4',
}

export enum EmergencyPriority {
  NORMAL = 'NORMAL',
  EMERGENCY = 'EMERGENCY',
}

export enum EmergencyTicketStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

export enum EmergencyTicketSource {
  PATIENT = 'PATIENT',
  FACILITY_ADMIN = 'FACILITY_ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum EmergencyTicketChannel {
  FEEDBACK = 'FEEDBACK',
  SUPPORT = 'SUPPORT',
  SETTINGS_ALERT = 'SETTINGS_ALERT',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum EmergencyReplyFrom {
  USER = 'USER',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum NotificationType {
  EMERGENCY_REPLY = 'EMERGENCY_REPLY',
  SYSTEM = 'SYSTEM',
  LAB_REPORT_REMINDER = 'LAB_REPORT_REMINDER',
}
