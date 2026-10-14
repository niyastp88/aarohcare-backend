import nodemailer from 'nodemailer';
import { logger } from './logger';

const gmailUser = () => process.env.GMAIL_USER?.trim() || '';
const gmailAppPassword = () => process.env.GMAIL_APP_PASSWORD?.trim() || '';

export const isMailConfigured = () => Boolean(gmailUser() && gmailAppPassword());

const getTransporter = () => {
  if (!isMailConfigured()) {
    throw new Error('Email is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.');
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: gmailUser(),
      pass: gmailAppPassword(),
    },
  });
};

export async function sendMail(options: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  const transporter = getTransporter();
  const from = process.env.MAIL_FROM?.trim() || `Aarohcare <${gmailUser()}>`;

  const info = await transporter.sendMail({
    from,
    to: options.to,
    subject: options.subject,
    text: options.text,
    html: options.html,
  });

  logger.info(`Email sent to ${options.to}: ${info.messageId}`);
  return info;
}

export async function sendPasswordResetEmail(options: {
  to: string;
  name: string;
  resetUrl: string;
}) {
  const subject = 'Reset your Aarohcare Admin password';
  const text = [
    `Hi ${options.name},`,
    '',
    'We received a request to reset your Aarohcare Admin password.',
    `Open this link to choose a new password (expires in 1 hour):`,
    options.resetUrl,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#111827">
      <h2 style="color:#0b2a4a;margin:0 0 12px">Reset your password</h2>
      <p>Hi ${options.name},</p>
      <p>We received a request to reset your Aarohcare Admin password.</p>
      <p>
        <a href="${options.resetUrl}"
           style="display:inline-block;background:#0b2a4a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">
          Reset password
        </a>
      </p>
      <p style="color:#6b7280;font-size:14px">This link expires in 1 hour. If you did not request this, ignore this email.</p>
    </div>
  `;

  return sendMail({ to: options.to, subject, text, html });
}
