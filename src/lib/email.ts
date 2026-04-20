import nodemailer from 'nodemailer';
import { env } from './env';

const transporter = nodemailer.createTransport({
  host: env.smtpHost,
  port: env.smtpPort,
  secure: env.smtpSecure,
  auth: { user: env.smtpUser, pass: env.smtpPass },
});

export async function sendOtp(to: string, code: string): Promise<void> {
  await transporter.sendMail({
    from: env.emailFrom,
    to,
    subject: 'Your LingoPlayer login code',
    text: `Your OTP code is: ${code}\n\nIt expires in 5 minutes.`,
  });
}
