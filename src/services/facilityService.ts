import bcrypt from 'bcryptjs';
import Doctor from '../models/Doctor';
import Facility from '../models/Facility';
import User from '../models/User';
import {
  FacilityApprovalStatus,
  FacilityType,
  UserRole,
} from '../constants/enums';
import { MSG } from '../constants/messages';
import type {
  IFacility,
  ILocation,
  WeekDay,
  ICancellationPolicy,
  ICancellationPolicyItem,
} from '../types';
import { AppError } from '../utils/AppError';
import { TIME_RE, parseLocation } from '../utils/validators';
import { authService, toLocalPhone } from './authService';

const WEEK_DAYS: WeekDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export type FacilityOwnUpdate = Partial<
  Pick<
    IFacility,
    | 'name'
    | 'place'
    | 'address'
    | 'location'
    | 'image'
    | 'isActive'
    | 'phone'
    | 'email'
    | 'workingHours'
    | 'openDays'
    | 'globalAlert'
    | 'bankAccountDetails'
    | 'razorpayAccountId'
    | 'cancellationPolicy'
  >
>;

const SUPER_ADMIN_PATCH_KEYS = [
  'name',
  'place',
  'address',
  'location',
  'image',
  'phone',
  'email',
  'workingHours',
  'openDays',
  'globalAlert',
  'isActive',
  'approvalStatus',
  'adminPassword',
  'bankAccountDetails',
  'razorpayAccountId',
  // Allow Super Admin to update the monthly payment status for a facility.
  'manualPaymentStatuses',
] as const;

export const facilityService = {
  /** Public patient/mobile listing — only approved + active facilities. */
  list: async (facilityType?: FacilityType) => {
    const filter: Record<string, unknown> = {
      isActive: { $ne: false },
      $or: [
        { approvalStatus: FacilityApprovalStatus.APPROVED },
        { approvalStatus: { $exists: false } },
        { approvalStatus: null },
      ],
    };
    if (facilityType) {
      filter.facilityType = facilityType;
    } else {
      filter.facilityType = { $in: Object.values(FacilityType) };
    }

    return Facility.find(filter)
      .select('name facilityType place location address phone email image isActive approvalStatus workingHours openDays')
      .sort({ name: 1 });
  },

  /** Older facilities were created before approvalStatus existed — treat them as approved. */
  backfillLegacyApproval: async () => {
    const result = await Facility.updateMany(
      {
        $or: [{ approvalStatus: { $exists: false } }, { approvalStatus: null }],
      },
      { $set: { approvalStatus: FacilityApprovalStatus.APPROVED } },
    );
    return result.modifiedCount;
  },

  listForSuperAdmin: async (opts?: {
    facilityType?: FacilityType;
    approvalStatus?: FacilityApprovalStatus;
  }) => {
    const filter: Record<string, unknown> = {};
    if (opts?.facilityType) filter.facilityType = opts.facilityType;
    if (opts?.approvalStatus) filter.approvalStatus = opts.approvalStatus;

    return Facility.find(filter)
      .populate('ownerId', 'name phone email role isActive')
      .sort({ createdAt: -1 });
  },

  findById: async (id: string) =>
    Facility.findById(id).populate('ownerId', 'name phone email role'),

  findByOwner: async (ownerId: string) => Facility.findOne({ ownerId }),

  findByPhone: async (phone: string) =>
    Facility.findOne({ phone: phone.replace(/\D/g, '') }),

  createForAdmin: async (data: {
    ownerId: string;
    name: string;
    facilityType: FacilityType;
    phone: string;
    email: string;
    place?: string;
    address?: string;
    location?: ILocation;
    image?: string;
    approvalStatus?: FacilityApprovalStatus;
    adminPassword?: string;
    bankAccountDetails?: {
      accountNumber?: string;
      ifscCode?: string;
      bankName?: string;
      accountHolderName?: string;
      upiId?: string;
      razorpayId?: string;
    };
    razorpayAccountId?: string;
  }) =>
    Facility.create({
      ...data,
      phone: data.phone.replace(/\D/g, ''),
      email: data.email.trim().toLowerCase(),
      approvalStatus: data.approvalStatus ?? FacilityApprovalStatus.PENDING,
      isActive: data.approvalStatus === FacilityApprovalStatus.APPROVED,
    }),

  /** Super Admin creates facility + owner, already approved/active. */
  createBySuperAdmin: async (data: {
    name: string;
    facilityType: FacilityType;
    phone: string;
    email: string;
    place?: string;
    address?: string;
    location?: ILocation;
    image?: string;
    ownerName: string;
    ownerPassword: string;
  }) => {
    const existingEmail = await authService.findByEmail(String(data.email));
    if (existingEmail) {
      return { ok: false as const, reason: 'email_taken' as const };
    }

    const owner = await authService.createUser({
      name: String(data.ownerName),
      phone: String(data.phone),
      password: String(data.ownerPassword),
      role: UserRole.ADMIN,
      email: String(data.email),
      facilityType: data.facilityType,
      place: data.place,
    });

    const facility = await facilityService.createForAdmin({
      ownerId: String(owner._id),
      name: String(data.name),
      facilityType: data.facilityType,
      phone: String(data.phone),
      email: String(data.email),
      place: data.place,
      address: data.address,
      location: data.location,
      image: data.image,
      adminPassword: data.ownerPassword,
      approvalStatus: FacilityApprovalStatus.APPROVED,
    });

    const created = await facilityService.findById(String(facility._id));
    return { ok: true as const, facility: created };
  },

  createFacilityForSuperAdmin: async (body: Record<string, unknown>) => {
    const {
      name,
      facilityType,
      phone,
      email,
      place,
      address,
      location,
      image,
      ownerName,
      ownerPassword,
    } = body;

    if (!name || !facilityType || !phone || !email || !ownerName || !ownerPassword) {
      throw AppError.badRequest(MSG.REQUIRED_FACILITY_CREATE);
    }
    if (!Object.values(FacilityType).includes(facilityType as FacilityType)) {
      throw AppError.badRequest(MSG.INVALID_FACILITY_TYPE);
    }

    const result = await facilityService.createBySuperAdmin({
      name: String(name),
      facilityType: facilityType as FacilityType,
      phone: String(phone),
      email: String(email),
      place: place as string | undefined,
      address: address as string | undefined,
      location: location as ILocation | undefined,
      image: image as string | undefined,
      ownerName: String(ownerName),
      ownerPassword: String(ownerPassword),
    });

    if (!result.ok) {
      throw AppError.badRequest(MSG.EMAIL_TAKEN);
    }
    return result.facility;
  },

  updateByOwner: async (ownerId: string, data: FacilityOwnUpdate) =>
    Facility.findOneAndUpdate({ ownerId }, data, { new: true }),

  updateById: async (id: string, data: Partial<IFacility> | Record<string, unknown>) =>
    Facility.findByIdAndUpdate(id, data, { new: true }).populate(
      'ownerId',
      'name phone email role',
    ),

  buildSuperAdminPatch: (body: Record<string, unknown>) => {
    const patch: Record<string, unknown> = {};
    for (const key of SUPER_ADMIN_PATCH_KEYS) {
      if (body[key] !== undefined) patch[key] = body[key];
    }

    if (
      patch.approvalStatus &&
      !Object.values(FacilityApprovalStatus).includes(
        patch.approvalStatus as FacilityApprovalStatus,
      )
    ) {
      return { ok: false as const, reason: 'invalid_approval' as const };
    }

    if (patch.approvalStatus === FacilityApprovalStatus.APPROVED) {
      patch.isActive = true;
    }
    if (patch.approvalStatus === FacilityApprovalStatus.REJECTED) {
      patch.isActive = false;
    }

    return { ok: true as const, patch };
  },

  updateFacilityForSuperAdmin: async (id: string, body: Record<string, unknown>) => {
    const built = facilityService.buildSuperAdminPatch(body);
    if (!built.ok) {
      throw AppError.badRequest(MSG.INVALID_APPROVAL);
    }

    if (body.location && typeof body.location === 'object') {
      const parsedLoc = parseLocation(body.location);
      if (parsedLoc) {
        built.patch.location = parsedLoc;
      }
    } else if (
      body.lat !== undefined &&
      body.lng !== undefined &&
      Number.isFinite(Number(body.lat)) &&
      Number.isFinite(Number(body.lng))
    ) {
      built.patch.location = {
        lat: Number(body.lat),
        lng: Number(body.lng),
        formattedAddress: typeof body.formattedAddress === 'string' ? body.formattedAddress : undefined,
      };
    }

    if (body.adminPassword || body.password) {
      const rawPassword = String(body.adminPassword || body.password).trim();
      if (rawPassword.length >= 6) {
        built.patch.adminPassword = rawPassword;
        const currentFacility = await Facility.findById(id);
        if (currentFacility?.ownerId) {
          const hashed = await bcrypt.hash(rawPassword, 10);
          await User.findByIdAndUpdate(currentFacility.ownerId, { password: hashed });
        }
      }
    }

    const facility = await facilityService.updateById(id, built.patch);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
    return facility;
  },

  requireById: async (id: string) => {
    const facility = await facilityService.findById(id);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
    return facility;
  },

  deleteById: async (id: string) => Facility.findByIdAndDelete(id),

  deleteWithDoctors: async (id: string) => {
    const facility = await facilityService.findById(id);
    if (!facility) return null;
    await Doctor.deleteMany({ facilityId: facility.id });
    await facilityService.deleteById(facility.id);
    return facility;
  },

  deleteFacilityForSuperAdmin: async (id: string) => {
    const facility = await facilityService.deleteWithDoctors(id);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
    return MSG.FACILITY_DELETED;
  },

  approve: async (id: string) =>
    facilityService.updateById(id, {
      approvalStatus: FacilityApprovalStatus.APPROVED,
      isActive: true,
    }),

  reject: async (id: string) =>
    facilityService.updateById(id, {
      approvalStatus: FacilityApprovalStatus.REJECTED,
      isActive: false,
    }),

  approveForSuperAdmin: async (id: string) => {
    const facility = await facilityService.approve(id);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
    return facility;
  },

  rejectForSuperAdmin: async (id: string) => {
    const facility = await facilityService.reject(id);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
    return facility;
  },

  broadcastAlert: async (opts: {
    message: string;
    facilityId?: string;
    city?: string;
  }) => {
    const filter: Record<string, unknown> = {
      approvalStatus: FacilityApprovalStatus.APPROVED,
    };
    if (opts.facilityId) filter._id = opts.facilityId;
    if (opts.city) filter.place = new RegExp(String(opts.city).trim(), 'i');

    const result = await Facility.updateMany(filter, {
      $set: { globalAlert: opts.message.trim() },
    });

    return {
      matched: result.matchedCount,
      modified: result.modifiedCount,
    };
  },

  broadcastAlertForSuperAdmin: async (body: {
    message?: string;
    facilityId?: string;
    city?: string;
  }) => {
    if (!body.message?.trim()) {
      throw AppError.badRequest(MSG.MESSAGE_REQUIRED);
    }
    const result = await facilityService.broadcastAlert({
      message: body.message,
      facilityId: body.facilityId,
      city: body.city,
    });
    return {
      message: MSG.ALERT_SENT,
      matched: result.matched,
      modified: result.modified,
    };
  },

  parseType: (raw?: string) =>
    raw && Object.values(FacilityType).includes(raw as FacilityType)
      ? (raw as FacilityType)
      : undefined,

  parseApproval: (raw?: string) =>
    raw && Object.values(FacilityApprovalStatus).includes(raw as FacilityApprovalStatus)
      ? (raw as FacilityApprovalStatus)
      : undefined,

  listFacilitiesForSuperAdmin: async (query: { type?: string; approvalStatus?: string }) =>
    facilityService.listForSuperAdmin({
      facilityType: facilityService.parseType(query.type),
      approvalStatus: facilityService.parseApproval(query.approvalStatus),
    }),

  countByType: async (facilityType: FacilityType) =>
    Facility.countDocuments({ facilityType }),

  countPending: async () =>
    Facility.countDocuments({ approvalStatus: FacilityApprovalStatus.PENDING }),

  publicSummaryForOwner: async (ownerId: string) => {
    const facility = await Facility.findOne({ ownerId }).select(
      'name facilityType approvalStatus isActive',
    );
    if (!facility) return null;
    return {
      _id: String(facility._id),
      name: facility.name,
      facilityType: facility.facilityType,
      approvalStatus: facility.approvalStatus || FacilityApprovalStatus.APPROVED,
      isActive: Boolean(facility.isActive),
    };
  },

  assertApprovedForOwner: async (ownerId: string) => {
    const facility = await facilityService.findByOwner(ownerId);
    if (!facility) {
      throw AppError.forbidden(MSG.FACILITY_AWAITING_APPROVAL);
    }
    const status = facility.approvalStatus || FacilityApprovalStatus.APPROVED;
    if (status === FacilityApprovalStatus.REJECTED) {
      throw AppError.forbidden(MSG.FACILITY_REJECTED);
    }
    if (status !== FacilityApprovalStatus.APPROVED) {
      throw AppError.forbidden(MSG.FACILITY_AWAITING_APPROVAL);
    }
    return facility;
  },

  updateOwnFacility: async (ownerId: string, body: Record<string, unknown>) => {
    const {
      name,
      place,
      address,
      location,
      image,
      phone,
      workingHours,
      openDays,
      globalAlert,
    } = body;

    const updates: Record<string, unknown> = {};
    if (typeof name === 'string' && name.trim()) updates.name = name.trim();
    if (typeof place === 'string') updates.place = place.trim();
    if (typeof address === 'string') updates.address = address.trim();
    if (typeof image === 'string') updates.image = image.trim();
    if (typeof globalAlert === 'string') updates.globalAlert = globalAlert.trim();

    const loc = parseLocation(location);
    if (loc) updates.location = loc;

    if (typeof phone === 'string') {
      const normalized = toLocalPhone(phone);
      if (normalized.length < 10) {
        throw AppError.badRequest(MSG.INVALID_PHONE);
      }
      const existing = await facilityService.findByPhone(normalized);
      if (existing && String(existing.ownerId) !== ownerId) {
        throw AppError.conflict(MSG.CONTACT_IN_USE);
      }
      const existingWithCc = await facilityService.findByPhone(`91${normalized}`);
      if (existingWithCc && String(existingWithCc.ownerId) !== ownerId) {
        throw AppError.conflict(MSG.CONTACT_IN_USE);
      }
      updates.phone = normalized;
    }

    if (workingHours && typeof workingHours === 'object') {
      const hours = workingHours as { from?: string; to?: string; is24Hours?: boolean };
      const is24Hours = Boolean(hours.is24Hours);
      let from = typeof hours.from === 'string' ? hours.from.trim() : '';
      let to = typeof hours.to === 'string' ? hours.to.trim() : '';
      if (is24Hours) {
        from = from || '00:00';
        to = to || '23:59';
        updates.workingHours = { from, to, is24Hours: true };
      } else {
        if (!TIME_RE.test(from) || !TIME_RE.test(to)) {
          throw AppError.badRequest(MSG.WORKING_HOURS_INVALID);
        }
        updates.workingHours = { from, to, is24Hours: false };
      }
    }

    if (Array.isArray(openDays)) {
      updates.openDays = openDays.filter((day): day is WeekDay =>
        WEEK_DAYS.includes(day as WeekDay),
      );
    }

    if (body.bankAccountDetails && typeof body.bankAccountDetails === 'object') {
      updates.bankAccountDetails = body.bankAccountDetails;
    }

    if (typeof body.razorpayAccountId === 'string') {
      updates.razorpayAccountId = body.razorpayAccountId.trim();
    }

    if (body.cancellationPolicy && typeof body.cancellationPolicy === 'object') {
      updates.cancellationPolicy = parseCancellationPolicy(body.cancellationPolicy);
    }

    if (Object.keys(updates).length === 0) {
      throw AppError.badRequest(MSG.NO_FIELDS);
    }

    const facility = await facilityService.updateByOwner(ownerId, updates);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
    return facility;
  },
};

const parseCancellationPolicy = (raw: unknown): ICancellationPolicy => {
  if (!raw || typeof raw !== 'object') {
    throw AppError.badRequest('Cancellation policy must be an object.');
  }
  const p = raw as Record<string, unknown>;

  const fullWindowRaw = p.fullRefundWindow as Record<string, unknown> | undefined;
  const fullVal = Number(fullWindowRaw?.value);
  const fullUnit = String(fullWindowRaw?.unit || 'minutes');
  if (!Number.isFinite(fullVal) || fullVal < 1 || !['minutes', 'hours', 'days'].includes(fullUnit)) {
    throw AppError.badRequest('Full-refund time limit must be a positive number with unit minutes, hours, or days.');
  }

  const afterPercent = Number(p.afterPeriodRefundPercent);
  if (!Number.isFinite(afterPercent) || afterPercent < 0 || afterPercent > 100) {
    throw AppError.badRequest('After-period refund percentage must be between 0 and 100.');
  }

  const procRaw = p.refundProcessingPeriod as Record<string, unknown> | undefined;
  const procVal = Number(procRaw?.value);
  const procUnit = String(procRaw?.unit || 'working_days');
  if (!Number.isFinite(procVal) || procVal < 1 || !['working_days', 'days', 'hours'].includes(procUnit)) {
    throw AppError.badRequest('Refund processing period must be a positive number with valid unit.');
  }

  let additionalItems: ICancellationPolicyItem[] = [];
  if (Array.isArray(p.additionalItems)) {
    additionalItems = p.additionalItems.map((item, idx) => {
      if (!item || typeof item !== 'object') {
        throw AppError.badRequest(`Invalid additional policy item at position ${idx + 1}`);
      }
      const icon = String(item.icon || '').trim();
      const textEn = String(item.text?.en || '').trim();
      const textMl = String(item.text?.ml || '').trim();
      if (!icon) {
        throw AppError.badRequest(`Additional policy item icon is required at position ${idx + 1}`);
      }
      if (!textEn) {
        throw AppError.badRequest(`Additional policy English text is required at position ${idx + 1}`);
      }
      if (textEn.length > 300 || textMl.length > 300) {
        throw AppError.badRequest(`Additional policy text cannot exceed 300 characters.`);
      }
      return {
        _id: item._id ? String(item._id) : undefined,
        icon,
        text: {
          en: textEn,
          ml: textMl,
        },
      };
    });
  }

  return {
    fullRefundWindow: {
      value: Math.round(fullVal),
      unit: fullUnit as 'minutes' | 'hours' | 'days',
    },
    afterPeriodRefundPercent: Math.round(afterPercent),
    refundProcessingPeriod: {
      value: Math.round(procVal),
      unit: procUnit as 'working_days' | 'days' | 'hours',
    },
    additionalItems,
  };
};
