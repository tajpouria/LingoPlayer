import { NextRequest, NextResponse } from 'next/server';
import { verifyOtp } from '@/src/lib/otp';
import { signToken } from '@/src/lib/jwt';
import { ensureUserFolder } from '@/src/lib/s3';

export async function POST(req: NextRequest) {
  try {
    const { email, code } = await req.json();

    if (!email || !code || typeof email !== 'string' || typeof code !== 'string') {
      return NextResponse.json({ error: 'Email and code are required' }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (!verifyOtp(normalizedEmail, code)) {
      return NextResponse.json({ error: 'Invalid or expired code' }, { status: 401 });
    }

    // Ensure user has an S3 folder
    await ensureUserFolder(normalizedEmail);

    // Issue JWT
    const token = await signToken(normalizedEmail);

    const res = NextResponse.json({ ok: true });
    res.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 24 * 60 * 60, // 60 days
      path: '/',
    });

    return res;
  } catch (e) {
    console.error('OTP verify error:', e);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}
