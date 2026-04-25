import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/src/lib/jwt';
import { readUserJson, writeUserJson } from '@/src/lib/s3';

interface Deck {
  name: string;
  dailyLearnLimit?: number;
  dailyRecallLimit?: number;
}

const DECKS_FILE = 'decks.json';

async function getEmail(req: NextRequest): Promise<string> {
  const token = req.cookies.get('token')?.value;
  if (!token) throw new Error('Unauthorized');
  const { email } = await verifyToken(token);
  return email;
}

export async function GET(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const decks = await readUserJson<Deck[]>(email, DECKS_FILE, []);
    return NextResponse.json(decks);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const { name } = await req.json();

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const decks = await readUserJson<Deck[]>(email, DECKS_FILE, []);
    decks.push({ name: name.trim() });
    await writeUserJson(email, DECKS_FILE, decks);
    return NextResponse.json(decks);
  } catch (e: any) {
    if (e.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Deck POST error:', e);
    return NextResponse.json({ error: 'Failed to save deck' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const { index, dailyLearnLimit, dailyRecallLimit } = await req.json();

    if (typeof index !== 'number') {
      return NextResponse.json({ error: 'index is required' }, { status: 400 });
    }

    const decks = await readUserJson<Deck[]>(email, DECKS_FILE, []);
    if (index < 0 || index >= decks.length) {
      return NextResponse.json({ error: 'Invalid index' }, { status: 400 });
    }

    if (typeof dailyLearnLimit === 'number') decks[index].dailyLearnLimit = Math.max(1, Math.floor(dailyLearnLimit));
    if (typeof dailyRecallLimit === 'number') decks[index].dailyRecallLimit = Math.max(1, Math.floor(dailyRecallLimit));

    await writeUserJson(email, DECKS_FILE, decks);
    return NextResponse.json(decks);
  } catch (e: any) {
    if (e.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Deck PATCH error:', e);
    return NextResponse.json({ error: 'Failed to update deck' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const { index } = await req.json();

    if (typeof index !== 'number') {
      return NextResponse.json({ error: 'index is required' }, { status: 400 });
    }

    const decks = await readUserJson<Deck[]>(email, DECKS_FILE, []);
    if (index < 0 || index >= decks.length) {
      return NextResponse.json({ error: 'Invalid index' }, { status: 400 });
    }

    decks.splice(index, 1);
    await writeUserJson(email, DECKS_FILE, decks);
    return NextResponse.json(decks);
  } catch (e: any) {
    if (e.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Deck DELETE error:', e);
    return NextResponse.json({ error: 'Failed to delete deck' }, { status: 500 });
  }
}
