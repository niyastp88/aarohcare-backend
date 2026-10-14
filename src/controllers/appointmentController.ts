import type { AuthRequest } from '../middleware/authMiddleware';
import { appointmentService } from '../services/appointmentService';
import { platformFeeService } from '../services/platformFeeService';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendOk } from '../utils/apiResponse';

import Facility from '../models/Facility';
import Doctor from '../models/Doctor';

export const getPlatformFee = asyncHandler(async (req: AuthRequest, res) => {
  let facilityId = typeof req.query.facilityId === 'string' ? req.query.facilityId : undefined;
  const doctorId = typeof req.query.doctorId === 'string' ? req.query.doctorId : undefined;
  let fee = await platformFeeService.get();
  
  // Use the facility-specific fee if available; otherwise use the global fee.
  if (!facilityId && doctorId) {
    const doctor = await Doctor.findById(doctorId);
    if (doctor?.facilityId) {
      facilityId = String(doctor.facilityId);
    } else if (doctor?.adminId) {
      const fac = await Facility.findOne({ ownerId: doctor.adminId });
      if (fac) facilityId = String(fac._id);
    }
  }

  if (facilityId) {
    const facility = await Facility.findById(facilityId);
    if (facility && facility.convenienceFeeOverride != null) {
      fee = facility.convenienceFeeOverride;
    }
  }
  
  return sendOk(res, { platformServiceFee: fee });
});

export const getAppointments = asyncHandler(async (req: AuthRequest, res) => {
  const doctorId = typeof req.query.doctorId === 'string' ? req.query.doctorId : undefined;
  return sendOk(
    res,
    await appointmentService.getAppointmentsForUser(req.user!.id, req.user!.role, doctorId),
  );
});

export const bookAppointment = asyncHandler(async (req: AuthRequest, res) => {
  const appointment = await appointmentService.bookAppointment(
    req.user!.id,
    req.user!.role,
    req.body,
  );
  return sendCreated(res, appointment);
});

export const verifyPayment = asyncHandler(async (req: AuthRequest, res) => {
  const updated = await appointmentService.verifyPayment(
    req.user!.id,
    req.body.appointmentId,
    req.body
  );
  return sendOk(res, updated);
});

export const updateAppointmentStatus = asyncHandler(async (req: AuthRequest, res) => {
  const { appointmentId } = req.params;
  const updated = await appointmentService.updateAppointmentStatus(
    req.user!.id,
    req.user!.role,
    String(appointmentId),
    req.body,
  );
  return sendOk(res, updated);
});

export const markAppointmentArrived = asyncHandler(async (req: AuthRequest, res) => {
  const { appointmentId } = req.params;
  const updated = await appointmentService.markArrivedForAdmin(
    req.user!.id,
    req.user!.role,
    String(appointmentId),
  );
  return sendOk(res, updated);
});

export const unmarkAppointmentArrived = asyncHandler(async (req: AuthRequest, res) => {
  const { appointmentId } = req.params;
  const updated = await appointmentService.unmarkArrivedForAdmin(
    req.user!.id,
    req.user!.role,
    String(appointmentId),
  );
  return sendOk(res, updated);
});

/** Patient cancels own PENDING booking and stores refund details for admin. */
export const cancelAppointmentByPatient = asyncHandler(async (req: AuthRequest, res) => {
  const { appointmentId } = req.params;
  const updated = await appointmentService.cancelByPatient(
    req.user!.id,
    req.user!.role,
    String(appointmentId),
    req.body?.refundPhone,
    req.body?.refundUpiId,
  );
  return sendOk(res, updated);
});

/** Patients who booked with this admin's doctors (search + date + pagination). */
export const getFacilityPatients = asyncHandler(async (req: AuthRequest, res) => {
  const result = await appointmentService.getFacilityPatients(req.user!.id, req.user!.role, {
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    fromDate: typeof req.query.fromDate === 'string' ? req.query.fromDate : undefined,
    toDate: typeof req.query.toDate === 'string' ? req.query.toDate : undefined,
    page: typeof req.query.page === 'string' ? Number(req.query.page) : 1,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : 20,
    refundStatus:
      req.query.refundStatus === 'pending' || req.query.refundStatus === 'refunded'
        ? req.query.refundStatus
        : undefined,
    bookingType:
      req.query.bookingType === 'online' || req.query.bookingType === 'offline'
        ? req.query.bookingType
        : undefined,
    patientType:
      req.query.patientType === 'registered' || req.query.patientType === 'walkin'
        ? req.query.patientType
        : undefined,
    status:
      req.query.status === 'cancelled' ? req.query.status : undefined,
    dayOfWeek:
      typeof req.query.dayOfWeek === 'string' &&
      !isNaN(Number(req.query.dayOfWeek)) &&
      Number(req.query.dayOfWeek) >= 1 &&
      Number(req.query.dayOfWeek) <= 7
        ? Number(req.query.dayOfWeek)
        : undefined,
  });
  return sendOk(res, result);
});

export const markAppointmentRefunded = asyncHandler(async (req: AuthRequest, res) => {
  const { appointmentId } = req.params;
  const refunded = req.body?.refunded !== false;
  const updated = await appointmentService.markCancellationRefunded(
    req.user!.id,
    req.user!.role,
    String(appointmentId),
    refunded,
  );
  return sendOk(res, updated);
});

/** One registered patient's profile + all bookings at this facility. */
export const getFacilityPatientDetail = asyncHandler(async (req: AuthRequest, res) => {
  const result = await appointmentService.getFacilityPatientDetail(
    req.user!.id,
    req.user!.role,
    String(req.params.patientId),
  );
  return sendOk(res, result);
});

/** Admin updates a patient's details. */
export const updateFacilityPatientDetail = asyncHandler(async (req: AuthRequest, res) => {
  const result = await appointmentService.updateFacilityPatientDetail(
    req.user!.id,
    req.user!.role,
    String(req.params.patientId),
    req.body,
  );
  return sendOk(res, result);
});

/** Admin creates an offline / walk-in booking for a specific upcoming OP number. */
export const bookOfflineAppointment = asyncHandler(async (req: AuthRequest, res) => {
  const appointment = await appointmentService.bookOfflineAppointment(
    req.user!.id,
    req.user!.role,
    req.body,
  );
  return sendCreated(res, appointment);
});

/** Admin searches previous OP bookings by phone for auto-filling offline booking details. */
export const lookupPatientByPhone = asyncHandler(async (req: AuthRequest, res) => {
  const phone = typeof req.query.phone === 'string' ? req.query.phone : '';
  const patients = await appointmentService.lookupPatientByPhone(
    req.user!.id,
    phone,
  );
  return sendOk(res, patients);
});

/** Return facility cancellation policy for an appointment or facility. */
export const getCancellationPolicy = asyncHandler(async (req: AuthRequest, res) => {
  const appointmentId =
    typeof req.params.appointmentId === 'string' ? req.params.appointmentId : undefined;
  const facilityId = typeof req.query.facilityId === 'string' ? req.query.facilityId : undefined;
  const doctorId = typeof req.query.doctorId === 'string' ? req.query.doctorId : undefined;

  let policyFacility = null;

  if (appointmentId) {
    const appointment = await appointmentService.findById(appointmentId);
    if (appointment?.doctorId) {
      const doctor = await Doctor.findById(appointment.doctorId);
      if (doctor?.facilityId) {
        policyFacility = await Facility.findById(doctor.facilityId);
      } else if (doctor?.adminId) {
        policyFacility = await Facility.findOne({ ownerId: doctor.adminId });
      }
    }
  } else if (facilityId) {
    policyFacility = await Facility.findById(facilityId);
  } else if (doctorId) {
    const doctor = await Doctor.findById(doctorId);
    if (doctor?.facilityId) {
      policyFacility = await Facility.findById(doctor.facilityId);
    } else if (doctor?.adminId) {
      policyFacility = await Facility.findOne({ ownerId: doctor.adminId });
    }
  }

  const defaultPolicy = {
    fullRefundWindow: { value: 30, unit: 'minutes' },
    afterPeriodRefundPercent: 90,
    refundProcessingPeriod: { value: 7, unit: 'working_days' },
    additionalItems: [],
  };

  const policy = policyFacility?.cancellationPolicy;
  return sendOk(res, {
    cancellationPolicy: {
      fullRefundWindow: policy?.fullRefundWindow || defaultPolicy.fullRefundWindow,
      afterPeriodRefundPercent:
        typeof policy?.afterPeriodRefundPercent === 'number'
          ? policy.afterPeriodRefundPercent
          : defaultPolicy.afterPeriodRefundPercent,
      refundProcessingPeriod: policy?.refundProcessingPeriod || defaultPolicy.refundProcessingPeriod,
      additionalItems: policy?.additionalItems || [],
    },
  });
});

