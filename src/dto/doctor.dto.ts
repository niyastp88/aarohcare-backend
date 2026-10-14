/** Doctor is a facility employee record — not a login account. */
export interface DoctorResponseDto {
  _id: string;
  name: string;
  specialization?: string;
  phone?: string;
  email?: string;
  qualifications?: string;
  consultationFee?: number;
  place?: string;
  profileImage?: string;
  isActive: boolean;
  adminId: string;
  liveOp?: {
    date?: string;
    currentNumber?: number;
    onBreak?: boolean;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateDoctorRequestDto {
  name: string;
  specialization?: string;
  phone?: string;
  email?: string;
  qualifications?: string;
  consultationFee?: number;
  place?: string;
  profileImage?: string;
}

export type UpdateDoctorRequestDto = Partial<CreateDoctorRequestDto> & {
  isActive?: boolean;
};

export interface CreateScheduleRequestDto {
  doctorId: string;
  date: string;
  startTime: string;
  endTime: string;
  intervalMinutes?: number;
  maxTokens?: number;
}

export interface ScheduleSlotDto {
  time: string;
  isBooked: boolean;
}

export interface ScheduleResponseDto {
  _id: string;
  doctorId: string;
  date: string;
  startTime?: string;
  endTime?: string;
  slots: ScheduleSlotDto[];
  maxTokens?: number;
  isClosed?: boolean;
  /** Next OP number a patient would get if they book this day. */
  nextTokenNumber?: string;
}
