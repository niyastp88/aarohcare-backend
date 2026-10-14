import Razorpay from 'razorpay';
import crypto from 'crypto';
import { AppError } from '../utils/AppError';

// Initialize razorpay securely (keys should be in .env)
// For development without keys, we can mock or throw error if not set
const getRazorpayInstance = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw AppError.internal('Razorpay keys not configured');
  }
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};

export const razorpayService = {
  /**
   * Creates a Razorpay Route Order transferring 100% to the Admin's Linked Account
   */
  createOrder: async (amountInRupees: number, linkedAccountId?: string) => {
    try {
      const rzp = getRazorpayInstance();
      const amountInPaise = Math.round(amountInRupees * 100);
      const isTestMode = (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_test_');

      const orderOptions: any = {
        amount: amountInPaise,
        currency: 'INR',
        receipt: `receipt_${Date.now()}`,
      };

      // If linked account is valid and route enabled, attempt Route transfer
      const enableRoute = process.env.RAZORPAY_ENABLE_ROUTE === 'true';
      if (linkedAccountId && enableRoute && linkedAccountId.startsWith('acc_')) {
        orderOptions.transfers = [
          {
            account: linkedAccountId,
            amount: amountInPaise,
            currency: 'INR',
            notes: {
              info: 'Booking Payment Route to Admin',
            },
            linked_account_notes: ['info'],
            on_hold: false,
          },
        ];
      }

      let order;
      try {
        order = await rzp.orders.create(orderOptions);
      } catch (orderErr) {
        if (orderOptions.transfers) {
          console.warn('[Razorpay Service] Route Transfer Order failed, falling back to direct order:', orderErr);
          delete orderOptions.transfers;
          try {
            order = await rzp.orders.create(orderOptions);
          } catch (directErr) {
            if (process.env.NODE_ENV === 'development') {
              console.warn('[Razorpay Service] Razorpay direct order failed in dev, simulating order for testing:', directErr);
              order = {
                id: `order_test_${Date.now()}`,
                entity: 'order',
                amount: amountInPaise,
                currency: 'INR',
                receipt: orderOptions.receipt,
                status: 'created',
              };
            } else {
              throw directErr;
            }
          }
        } else {
          if (process.env.NODE_ENV === 'development') {
            console.warn('[Razorpay Service] Razorpay order creation failed in dev, simulating order for testing:', orderErr);
            order = {
              id: `order_test_${Date.now()}`,
              entity: 'order',
              amount: amountInPaise,
              currency: 'INR',
              receipt: orderOptions.receipt,
              status: 'created',
            };
          } else {
            throw orderErr;
          }
        }
      }

      console.log(
        `[Razorpay Service] Order Created Successfully: orderId=${order.id}, amount=${amountInPaise} paise, currency=INR, mode=${isTestMode ? 'test' : 'live'}`,
      );
      return order;
    } catch (error: any) {
      console.error('[Razorpay Service] Order Error:', error?.message || error);
      throw AppError.internal('Failed to create payment order');
    }
  },

  /**
   * Verifies the signature from Razorpay frontend callback
   */
  verifySignature: (orderId: string, paymentId: string, signature: string) => {
    const secret = process.env.RAZORPAY_KEY_SECRET || '';
    if (process.env.NODE_ENV === 'development' && (secret === 'YOUR_RAZORPAY_SECRET' || orderId.startsWith('order_test_'))) {
      return true;
    }
    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    return generatedSignature === signature;
  },

  /**
   * Issues a refund. If it was a Route transfer, Razorpay will handle reversing it.
   */
  issueRefund: async (paymentId: string, amountInRupees?: number) => {
    try {
      const rzp = getRazorpayInstance();
      const options: any = {};
      if (amountInRupees) {
        options.amount = Math.round(amountInRupees * 100);
      }
      const refund = await rzp.payments.refund(paymentId, options);
      return refund;
    } catch (error: any) {
      console.error('Razorpay Refund Error:', error);
      throw AppError.internal('Failed to issue refund');
    }
  },
};
