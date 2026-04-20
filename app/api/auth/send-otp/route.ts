import { NextRequest, NextResponse } from 'next/server';
import { generateOtp } from '@/src/lib/otp';
import { sendOtp } from '@/src/lib/email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Rate limit: max 3 OTP sends per email per 15 min
const sendLimits = new Map<string, { count: number; resetAt: number }>();
const SEND_LIMIT = 3;
const SEND_WINDOW = 15 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check send rate limit
    const now = Date.now();
    const limit = sendLimits.get(normalizedEmail);
    if (limit && now < limit.resetAt && limit.count >= SEND_LIMIT) {
      return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
    }

    const code = generateOtp(normalizedEmail);
    await sendOtp(normalizedEmail, code);

    // Track send count
    if (!limit || now >= limit.resetAt) {
      sendLimits.set(normalizedEmail, { count: 1, resetAt: now + SEND_WINDOW });
    } else {
      limit.count++;
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('OTP send error:', e);
    return NextResponse.json({ error: 'Failed to send OTP' }, { status: 500 });
  }
}
