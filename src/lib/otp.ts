import crypto from 'crypto';

// In-memory OTP store (email → { code, expiresAt })
// In production, use Redis or a DB instead.
const store = new Map<string, { code: string; expiresAt: number }>();

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

const attempts = new Map<string, { count: number; resetAt: number }>();

export function generateOtp(email: string): string {
  const code = crypto.randomInt(100_000, 999_999).toString();
  store.set(email, { code, expiresAt: Date.now() + OTP_TTL_MS });
  return code;
}

export function verifyOtp(email: string, code: string): boolean {
  // Rate-limit verification attempts
  const now = Date.now();
  const att = attempts.get(email);
  if (att && att.count >= MAX_ATTEMPTS && now < att.resetAt) {
    return false; // Too many attempts
  }

  const entry = store.get(email);
  if (!entry || now > entry.expiresAt) {
    store.delete(email);
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  const valid =
    code.length === entry.code.length &&
    crypto.timingSafeEqual(Buffer.from(code), Buffer.from(entry.code));

  if (valid) {
    store.delete(email);
    attempts.delete(email);
    return true;
  }

  // Track failed attempt
  const current = attempts.get(email) || { count: 0, resetAt: now + OTP_TTL_MS };
  current.count++;
  attempts.set(email, current);
  return false;
}
