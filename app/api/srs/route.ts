import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/src/lib/jwt';
import { readUserJson, writeUserJson } from '@/src/lib/s3';

async function getEmail(req: NextRequest): Promise<string> {
  const token = req.cookies.get('token')?.value;
  if (!token) throw new Error('Unauthorized');
  const { email } = await verifyToken(token);
  return email;
}

function srsFile(deckName: string): string {
  const safe = deckName.replace(/[^a-zA-Z0-9 _-]/g, '_');
  return `srs_${safe}.json`;
}

export async function GET(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const deckName = req.nextUrl.searchParams.get('deck');
    if (!deckName) return NextResponse.json({ error: 'deck param required' }, { status: 400 });
    const stored = await readUserJson<{ key: string; data: Record<string, unknown> }>(email, srsFile(deckName), { key: `srs_${deckName}`, data: {} });
    return NextResponse.json(stored);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const body = await req.json();
    const deck: string = body.deck;
    // Accept both { deck, srs } and { deck, key, data } formats
    const srsData = body.data ?? body.srs;
    if (!deck || typeof deck !== 'string' || !srsData || typeof srsData !== 'object') {
      return NextResponse.json({ error: 'deck and srs data are required' }, { status: 400 });
    }
    await writeUserJson(email, srsFile(deck), { key: `srs_${deck}`, data: srsData });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('SRS PUT error:', e);
    return NextResponse.json({ error: 'Failed to save SRS' }, { status: 500 });
  }
}
