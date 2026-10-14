import { Request } from 'express';
import { FacilityType } from '../constants/enums';
import type { AuthRequest } from '../middleware/authMiddleware';
import { facilityService } from '../services/facilityService';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { sendOk } from '../utils/apiResponse';

/** Public facility list for the patient app (hospitals / clinics / labs). */
export const getFacilities = asyncHandler(async (req: Request, res) => {
  const typeParam = typeof req.query.type === 'string' ? req.query.type : undefined;
  const facilityType =
    typeParam && Object.values(FacilityType).includes(typeParam as FacilityType)
      ? (typeParam as FacilityType)
      : undefined;

  return sendOk(res, await facilityService.list(facilityType));
});

/** Logged-in facility admin loads their own facility profile. */
export const getMyFacility = asyncHandler(async (req: AuthRequest, res) => {
  const facility = await facilityService.findByOwner(req.user!.id);
  if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
  return sendOk(res, facility);
});

/** Facility admin updates their profile (photo, place, hours, etc.). */
export const updateMyFacility = asyncHandler(async (req: AuthRequest, res) => {
  const facility = await facilityService.updateOwnFacility(
    req.user!.id,
    (req.body ?? {}) as Record<string, unknown>,
  );
  return sendOk(res, facility);
});
