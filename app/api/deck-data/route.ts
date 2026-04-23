import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/src/lib/jwt';
import { readUserJson, writeUserJson } from '@/src/lib/s3';

interface Row {
  word: string;
  sentences: string[];
}

async function getEmail(req: NextRequest): Promise<string> {
  const token = req.cookies.get('token')?.value;
  if (!token) throw new Error('Unauthorized');
  const { email } = await verifyToken(token);
  return email;
}

function deckFile(deckName: string): string {
  return `deck-data-${deckName.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

export async function GET(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const deck = req.nextUrl.searchParams.get('deck');
    if (!deck) return NextResponse.json({ error: 'deck is required' }, { status: 400 });
    const rows = await readUserJson<Row[]>(email, deckFile(deck), []);
    return NextResponse.json(rows);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const { deck, rows } = await req.json();
    if (!deck || !Array.isArray(rows)) {
      return NextResponse.json({ error: 'deck and rows are required' }, { status: 400 });
    }
    const clean: Row[] = rows
      .filter((r: Row) => r.word && typeof r.word === 'string')
      .map((r: Row) => ({ word: String(r.word).trim(), sentences: (r.sentences || []).map(String) }));
    await writeUserJson(email, deckFile(deck), clean);
    return NextResponse.json({ ok: true, count: clean.length });
  } catch (e: any) {
    if (e.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
}
