import User from '../models/User';
import LabReport from '../models/LabReport';
import Appointment from '../models/Appointment';
import { UserRole } from '../constants/enums';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';
import { parseLocation } from '../utils/validators';
import { appointmentService } from './appointmentService';

export const userService = {
  findById: async (id: string) => User.findById(id),

  updateById: async (id: string, data: Record<string, unknown>) =>
    User.findByIdAndUpdate(id, data, { new: true }),

  listForSuperAdmin: async (role?: string) => {
    const filter: Record<string, unknown> = {};
    if (role && Object.values(UserRole).includes(role as UserRole)) {
      filter.role = role;
    }
    const users = await User.find(filter)
      .select('-password -passwordResetToken -passwordResetExpires')
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();

    if (role !== UserRole.PATIENT) return users;

    const stats = await Appointment.aggregate<{
      _id: unknown;
      bookingCount: number;
      lastBookingAt?: Date;
    }>([
      { $match: { patientId: { $in: users.map((user) => user._id) } } },
      {
        $group: {
          _id: '$patientId',
          bookingCount: { $sum: 1 },
          lastBookingAt: { $max: '$createdAt' },
        },
      },
    ]);
    const byPatient = new Map(
      stats.map((row) => [String(row._id), row] as const),
    );

    return users.map((user) => {
      const row = byPatient.get(String(user._id));
      const fallbackId = `AC${String(user._id).slice(-6).toUpperCase()}`;
      return {
        ...user,
        healthCardId: user.healthCardId || fallbackId,
        bookingCount: row?.bookingCount ?? 0,
        lastBookingAt: row?.lastBookingAt,
        isRegistered: Boolean(user.termsAcceptedAt),
      };
    });
  },

  getDetailForSuperAdmin: async (id: string) => {
    const user = await User.findById(id)
      .select('-password -passwordResetToken -passwordResetExpires')
      .lean();
    if (!user) return null;

    const fallbackId = `AC${String(user._id).slice(-6).toUpperCase()}`;
    const [appointments, labReports] = await Promise.all([
      appointmentService.listForPatient(String(user._id)),
      LabReport.find({ patientId: user._id })
        .populate('facilityId', 'name facilityType')
        .sort({ createdAt: -1 }),
    ]);

    return {
      user: {
        ...user,
        healthCardId: user.healthCardId || fallbackId,
        isRegistered: Boolean(user.termsAcceptedAt),
        bookingCount: appointments.length,
      },
      appointments,
      labReports,
    };
  },

  requireDetailForSuperAdmin: async (id: string) => {
    const detail = await userService.getDetailForSuperAdmin(id);
    if (!detail) throw AppError.notFound(MSG.USER_NOT_FOUND);
    return detail;
  },

  blockById: async (id: string) =>
    User.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true }).select(
      '-password',
    ),

  blockForSuperAdmin: async (id: string) => {
    const user = await userService.blockById(id);
    if (!user) throw AppError.notFound(MSG.USER_NOT_FOUND);
    return user;
  },

  countPatients: async () => User.countDocuments({ role: UserRole.PATIENT }),

  buildProfilePatch: (body: Record<string, unknown>) => {
    const {
      name,
      place,
      address,
      location,
      age,
      dateOfBirth,
      bloodGroup,
      profileImage,
      gender,
      email,
    } = body;

    const updates: Record<string, unknown> = {};
    if (typeof name === 'string' && name.trim()) updates.name = name.trim();
    if (typeof place === 'string') updates.place = place.trim();
    if (typeof address === 'string') updates.address = address.trim();
    if (typeof bloodGroup === 'string') updates.bloodGroup = bloodGroup.trim();
    if (typeof profileImage === 'string') updates.profileImage = profileImage.trim();
    if (typeof gender === 'string') updates.gender = gender.trim();
    if (typeof email === 'string') updates.email = email.trim();
    if (typeof dateOfBirth === 'string') updates.dateOfBirth = dateOfBirth;
    if (typeof age === 'number' && Number.isFinite(age)) updates.age = age;

    const loc = parseLocation(location);
    if (loc) {
      updates.location = loc;
      if (!updates.address && loc.formattedAddress) {
        updates.address = loc.formattedAddress;
      }
      if (!updates.place && typeof place !== 'string' && loc.formattedAddress) {
        updates.place =
          loc.formattedAddress.split(',')[0]?.trim() || loc.formattedAddress;
      }
    }

    if (Object.keys(updates).length === 0) {
      throw AppError.badRequest(MSG.NO_FIELDS);
    }
    return updates;
  },

  updateProfile: async (userId: string, body: Record<string, unknown>) => {
    const updates = userService.buildProfilePatch(body);
    const user = await userService.updateById(userId, updates);
    if (!user) throw AppError.notFound(MSG.USER_NOT_FOUND);
    return user;
  },

  requireById: async (id: string) => {
    const user = await userService.findById(id);
    if (!user) throw AppError.notFound(MSG.USER_NOT_FOUND);
    return user;
  },
};
