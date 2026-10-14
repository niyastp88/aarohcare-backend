import Feedback from '../models/Feedback';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';
import { emergencyTicketService } from './emergencyTicketService';

export const feedbackService = {
  create: async (patientId: string, ratingRaw: unknown, messageRaw: unknown) => {
    const rating = Number(ratingRaw);
    const message = typeof messageRaw === 'string' ? messageRaw.trim() : '';

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw AppError.badRequest(MSG.RATING_RANGE);
    }
    if (message.length < 4 || message.length > 2000) {
      throw AppError.badRequest(MSG.FEEDBACK_LENGTH);
    }

    const feedback = await Feedback.create({ patientId, rating, message });
    try {
      await emergencyTicketService.createFromPatientFeedback(patientId, rating, message);
    } catch {
      // Feedback still stands if the emergency inbox write fails.
    }
    return feedback;
  },

  list: async () =>
    Feedback.find()
      .populate('patientId', 'name phone email healthCardId profileImage')
      .sort({ createdAt: -1 })
      .lean(),
};
