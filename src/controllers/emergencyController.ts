import type { AuthRequest } from '../middleware/authMiddleware';
import { emergencyTicketService } from '../services/emergencyTicketService';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendOk } from '../utils/apiResponse';

export const createEmergencyTicket = asyncHandler(async (req: AuthRequest, res) => {
  return sendCreated(
    res,
    await emergencyTicketService.createForUser(req.user!.id, req.user!.role, req.body ?? {}),
  );
});

export const listMyEmergencyTickets = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await emergencyTicketService.listMine(req.user!.id));
});

export const replyMyEmergencyTicket = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await emergencyTicketService.replyForOwner(
      String(req.params.id),
      req.body?.body,
      req.user!.id,
      req.body?.priority,
    ),
  );
});
