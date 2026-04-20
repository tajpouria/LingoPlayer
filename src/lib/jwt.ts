import { SignJWT, jwtVerify } from 'jose';
import { env } from './env';

const secret = () => new TextEncoder().encode(env.jwtSecret);

export async function signToken(email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('60d')
    .sign(secret());
}

export async function verifyToken(token: string): Promise<{ email: string }> {
  const { payload } = await jwtVerify(token, secret());
  return { email: payload.email as string };
}
