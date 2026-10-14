import { Request } from 'express';
import { AdPlacement } from '../constants/enums';
import { adService } from '../services/adService';
import { asyncHandler } from '../utils/asyncHandler';
import { sendOk } from '../utils/apiResponse';

/** Active campaigns for the patient app home banner. */
export const listActiveAds = asyncHandler(async (req: Request, res) => {
  const placement =
    typeof req.query.placement === 'string' ? req.query.placement : 'HOME';
  return sendOk(res, await adService.listActiveForApp(placement as AdPlacement));
});

/** Record an ad impression with view duration from the patient app. */
export const recordImpression = asyncHandler(async (req: Request, res) => {
  const { id } = req.params;
  const viewTimeMs = Number(req.body?.viewTimeMs);
  await adService.recordImpression(id as string, viewTimeMs);
  res.status(204).end();
});

/** Record a link click from the patient app. */
export const recordLinkClick = asyncHandler(async (req: Request, res) => {
  const { id } = req.params;
  await adService.recordLinkClick(id as string);
  res.status(204).end();
});
