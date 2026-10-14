import { FacilityApprovalStatus, UserRole } from '../constants/enums';
import { MSG } from '../constants/messages';
import { facilityService } from '../services/facilityService';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import type { AuthRequest } from './authMiddleware';

/**
 * Facility ADMIN may only operate the product after Super Admin approval.
 * Non-admin roles pass through (patient/super-admin on mixed routes).
 */
export const requireApprovedFacility = asyncHandler(async (req: AuthRequest, _res, next) => {
  if (!req.user) {
    throw AppError.unauthorized(MSG.NOT_AUTHORIZED);
  }
  if (req.user.role !== UserRole.ADMIN) {
    return next();
  }

  const facility = await facilityService.findByOwner(req.user.id);
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

  return next();
});
