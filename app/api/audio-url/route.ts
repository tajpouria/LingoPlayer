import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/src/lib/jwt';
import { readUserJson, getSignedAudioUrl } from '@/src/lib/s3';

async function getEmail(req: NextRequest): Promise<string> {
  const token = req.cookies.get('token')?.value;
  if (!token) throw new Error('Unauthorized');
  const { email } = await verifyToken(token);
  return email;
}

export async function POST(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const { hash } = await req.json() as { hash: string };

    if (!hash || !/^[0-9a-f]{8}$/.test(hash)) {
      return NextResponse.json({ error: 'Invalid hash' }, { status: 400 });
    }

    // Check manifest before generating a URL to avoid signing a key that doesn't exist.
    const manifest = await readUserJson<Record<string, true>>(email, 'audio-manifest.json', {});
    if (!manifest[hash]) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const url = await getSignedAudioUrl(email, hash);
    return NextResponse.json({ url });
  } catch (err) {
    const status = (err as Error).message === 'Unauthorized' ? 401 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
