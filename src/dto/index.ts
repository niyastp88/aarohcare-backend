export type {
  ApiErrorResponseDto,
  ApiMessageResponseDto,
  FacilityAccessDto,
  FacilityApprovalStatusDto,
  LocationDto,
  UserResponseDto,
} from './common.dto';
export type {
  AuthResponseDto,
  ForgotPasswordRequestDto,
  LoginRequestDto,
  MeResponseDto,
  RefreshRequestDto,
  RefreshResponseDto,
  RegisterRequestDto,
  ResetPasswordRequestDto,
  ChangePasswordRequestDto,
} from './auth.dto';
export type {
  CreateDoctorRequestDto,
  CreateScheduleRequestDto,
  DoctorResponseDto,
  ScheduleResponseDto,
  ScheduleSlotDto,
  UpdateDoctorRequestDto,
} from './doctor.dto';
export type {
  AppointmentResponseDto,
  BookAppointmentRequestDto,
  UpdateAppointmentStatusRequestDto,
} from './appointment.dto';
export type { ProfileResponseDto, UpdateProfileRequestDto } from './user.dto';
