import axios from 'axios';
import { AppError } from '../utils/AppError';

const getCashfreeConfig = () => {
  const envStr = (process.env.CASHFREE_ENV || 'TEST').toUpperCase().trim();
  const isProd = envStr === 'PROD' || envStr === 'PRODUCTION';

  const appId = (process.env.CASHFREE_APP_ID || '').trim();
  const secretKey = (process.env.CASHFREE_SECRET_KEY || '').trim();

  if (!appId || !secretKey) {
    if (isProd) {
      throw AppError.internal('Cashfree API credentials are not configured in environment variables');
    }
    return {
      baseUrl: 'https://sandbox.cashfree.com/pg',
      headers: {
        'x-client-id': '',
        'x-client-secret': '',
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json',
      },
      isMocked: true,
    };
  }

  const baseUrl = isProd
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';

  return {
    baseUrl,
    headers: {
      'x-client-id': appId,
      'x-client-secret': secretKey,
      'x-api-version': '2023-08-01',
      'Content-Type': 'application/json',
    },
    isMocked: false,
  };
};

export interface ICashfreeCustomerDetails {
  customerId: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
}

export const cashfreeService = {
  /**
   * Creates a Cashfree PG Order using direct REST API
   */
  createOrder: async (
    amountInRupees: number,
    customerDetails: ICashfreeCustomerDetails
  ) => {
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    try {
      const config = getCashfreeConfig();

      if (config.isMocked) {
        console.log('[Cashfree Service] Credentials not configured in TEST env — returning test session fallback.');
        return {
          orderId,
          paymentSessionId: `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          cfOrderId: orderId,
        };
      }

      const phoneDigits = (customerDetails.customerPhone || '').replace(/\D/g, '').slice(-10);
      const validPhone = phoneDigits.length === 10 ? phoneDigits : '9999999999';

      const frontendBaseUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const returnUrl = `${frontendBaseUrl}/payment/callback?order_id={order_id}`;

      const payload = {
        order_amount: Math.round(amountInRupees * 100) / 100,
        order_currency: 'INR',
        order_id: orderId,
        customer_details: {
          customer_id: customerDetails.customerId,
          customer_name: customerDetails.customerName || 'Patient',
          customer_email: customerDetails.customerEmail || 'patient@aarohcare.com',
          customer_phone: validPhone,
        },
        order_meta: {
          return_url: returnUrl,
        },
      };

      console.log(`[Cashfree REST] Requesting Order Creation at ${config.baseUrl}/orders...`);

      const response = await axios.post(`${config.baseUrl}/orders`, payload, {
        headers: config.headers,
        timeout: 15000,
      });

      const data = response.data;

      console.log(
        `[Cashfree Service] Order Created Successfully: orderId=${data.order_id}, paymentSessionId=${data.payment_session_id}`
      );

      return {
        orderId: String(data.order_id || orderId),
        paymentSessionId: String(data.payment_session_id || `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
        cfOrderId: data.cf_order_id ? String(data.cf_order_id) : orderId,
      };
    } catch (error: any) {
      const detail =
        error?.response?.data?.message ||
        error?.response?.data?.description ||
        error?.message ||
        'Timeout or Gateway Connection Failure';
      const statusCode = error?.response?.status;
      console.error('[Cashfree Service] Create Order Error:', statusCode, detail);

      const envStr = (process.env.CASHFREE_ENV || '').toUpperCase().trim();
      const isProd = envStr === 'PROD' || envStr === 'PRODUCTION';

      if (!isProd) {
        console.log('[Cashfree Service] TEST mode fallback — returning sandbox test session.');
        return {
          orderId: String(orderId),
          paymentSessionId: `session_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          cfOrderId: String(orderId),
        };
      }

      throw AppError.internal(`Failed to create payment order: ${detail}`);
    }
  },

  /**
   * Fetches order status from Cashfree and returns verification result
   */
  verifyOrder: async (orderId: string) => {
    try {
      const config = getCashfreeConfig();
      const response = await axios.get(`${config.baseUrl}/orders/${orderId}`, {
        headers: config.headers,
        timeout: 15000,
      });
      const data = response.data;
      const isPaid = data.order_status === 'PAID';

      return {
        isPaid,
        orderStatus: data.order_status,
        orderAmount: data.order_amount,
        cfOrderId: data.cf_order_id ? String(data.cf_order_id) : '',
      };
    } catch (error: any) {
      const detail =
        error?.response?.data?.message ||
        error?.response?.data?.description ||
        error?.message ||
        error;
      console.error('[Cashfree Service] Verify Order Error:', detail);
      throw AppError.internal(`Failed to verify Cashfree payment: ${detail}`);
    }
  },

  /**
   * Issues a refund for an order via Cashfree REST API
   */
  issueRefund: async (orderId: string, amountInRupees?: number) => {
    try {
      const config = getCashfreeConfig();
      const refundId = `ref_${Date.now()}`;
      const payload: any = {
        refund_id: refundId,
      };

      if (amountInRupees && amountInRupees > 0) {
        payload.refund_amount = Math.round(amountInRupees * 100) / 100;
      }

      const response = await axios.post(
        `${config.baseUrl}/orders/${orderId}/refunds`,
        payload,
        {
          headers: config.headers,
          timeout: 15000,
        }
      );
      console.log(`[Cashfree Service] Refund Processed: orderId=${orderId}, refundId=${refundId}`);
      return response.data;
    } catch (error: any) {
      const detail =
        error?.response?.data?.message ||
        error?.response?.data?.description ||
        error?.message ||
        error;
      console.error('[Cashfree Service] Refund Error:', detail);
      throw AppError.internal(`Failed to issue Cashfree refund: ${detail}`);
    }
  },
};
