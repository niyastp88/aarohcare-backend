import axios from 'axios';
import { logger } from '../utils/logger';

export interface BookingWhatsAppParams {
  recipientPhone: string;
  patientName: string;
  tokenNumber: string | number;
  doctorName: string;
  appointmentDate: string;
  facilityName?: string;
}

/**
 * Format recipient phone number for WhatsApp Meta Cloud API:
 * - Digits only
 * - Requires country code without '+' or leading '00'
 * - Defaults to Indian country code ('91') if a 10-digit mobile number is provided.
 */
export const formatWhatsAppPhone = (phone: string): string => {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) {
    return `91${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return `91${digits.slice(1)}`;
  }
  if (digits.length > 10 && digits.startsWith('91')) {
    return digits;
  }
  return digits;
};

export const whatsappService = {
  /**
   * Send WhatsApp Booking Confirmation Message via Meta Cloud API.
   * If WHATSAPP_TEMPLATE_NAME is defined, it attempts to send the approved Template message.
   * If template is not defined or template dispatch fails, it falls back to a direct text message.
   */
  sendBookingConfirmation: async (params: BookingWhatsAppParams): Promise<boolean> => {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    const token = (process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN)?.trim();

    if (!phoneNumberId || !token) {
      logger.warn('[WhatsApp] Skipped sending: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN is not configured in .env');
      return false;
    }

    const {
      recipientPhone,
      patientName,
      tokenNumber,
      doctorName,
      appointmentDate,
      facilityName,
    } = params;

    const formattedTo = formatWhatsAppPhone(recipientPhone);
    if (!formattedTo || formattedTo.length < 10) {
      logger.warn(`[WhatsApp] Invalid recipient phone: ${recipientPhone}`);
      return false;
    }

    const cleanDoctorName = doctorName.replace(/^Dr\.?\s*/i, '').trim();
    const cleanFacilityName = facilityName?.trim() || 'AarohCare Partner Clinic';
    const templateName = process.env.WHATSAPP_TEMPLATE_NAME?.trim();
    const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || 'en_US';

    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // 1. Try sending as Template if WHATSAPP_TEMPLATE_NAME is defined in .env
    if (templateName) {
      try {
        const templatePayload = {
          messaging_product: 'whatsapp',
          to: formattedTo,
          type: 'template',
          template: {
            name: templateName,
            language: { code: languageCode },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: patientName },
                  { type: 'text', text: String(tokenNumber) },
                  { type: 'text', text: cleanDoctorName },
                  { type: 'text', text: appointmentDate },
                ],
              },
            ],
          },
        };

        const response = await axios.post(url, templatePayload, { headers });
        logger.info(
          `[WhatsApp] Template message "${templateName}" sent successfully to ${formattedTo}. Message ID: ${response.data?.messages?.[0]?.id}`,
        );
        return true;
      } catch (templateError: any) {
        const errorMsg =
          templateError.response?.data?.error?.message || templateError.message;
        const errorCode = templateError.response?.data?.error?.code;
        logger.warn(
          `[WhatsApp] Template "${templateName}" failed or pending review (${errorMsg}).`,
        );

        // While custom template is in Meta review (code 132001), send approved hello_world template so booking notifications work in test mode
        if (errorCode === 132001 && templateName !== 'hello_world') {
          try {
            const fallbackPayload = {
              messaging_product: 'whatsapp',
              to: formattedTo,
              type: 'template',
              template: {
                name: 'hello_world',
                language: { code: 'en_US' },
              },
            };
            const fallbackRes = await axios.post(url, fallbackPayload, { headers });
            logger.info(
              `[WhatsApp] While "${templateName}" is in review, test template "hello_world" was successfully delivered to ${formattedTo}. Message ID: ${fallbackRes.data?.messages?.[0]?.id}`,
            );
            return true;
          } catch (fbErr: any) {
            logger.warn(`[WhatsApp] Fallback template error: ${fbErr.message}`);
          }
        }
      }
    }

    // 2. Direct Text Message Fallback
    try {
      const textBody =
        `🎉 Congratulations, ${patientName}! Your appointment is confirmed.\n\n` +
        `🎟️ OP Token No: ${tokenNumber}\n` +
        `🏥 Clinic/Hospital: ${cleanFacilityName}\n` +
        `👨‍⚕️ Doctor: Dr. ${cleanDoctorName}\n` +
        `📅 Date: ${appointmentDate}\n\n` +
        `💙 Thank you for trusting AarohCare. Your health matters to us!`;

      const textPayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: formattedTo,
        type: 'text',
        text: {
          preview_url: false,
          body: textBody,
        },
      };

      const response = await axios.post(url, textPayload, { headers });
      logger.info(
        `[WhatsApp] Text message sent successfully to ${formattedTo}. Message ID: ${response.data?.messages?.[0]?.id}`,
      );
      return true;
    } catch (textError: any) {
      const errDetails = textError.response?.data?.error || textError.message;
      logger.error('[WhatsApp] Failed to send WhatsApp message via Meta Cloud API:', errDetails);
      return false;
    }
  },
};
