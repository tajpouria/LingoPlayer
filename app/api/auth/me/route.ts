import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/src/lib/jwt';

export async function GET(req: NextRequest) {
  const token = req.cookies.get('token')?.value;
  if (!token) {
    return NextResponse.json({ email: null }, { status: 401 });
  }
  try {
    const { email } = await verifyToken(token);
    return NextResponse.json({ email });
  } catch {
    return NextResponse.json({ email: null }, { status: 401 });
  }
}
