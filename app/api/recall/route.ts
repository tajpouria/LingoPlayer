import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/src/lib/jwt';
import { readUserJson, writeUserJson } from '@/src/lib/s3';

async function getEmail(req: NextRequest): Promise<string> {
  const token = req.cookies.get('token')?.value;
  if (!token) throw new Error('Unauthorized');
  const { email } = await verifyToken(token);
  return email;
}

function recallFile(deckName: string): string {
  const safe = deckName.replace(/[^a-zA-Z0-9 _-]/g, '_');
  return `recall_${safe}.json`;
}

// Recall state tracks which sentences have been completed (first try success)
// and the daily session state
export interface RecallState {
  // Set of sentence IDs that have been completed (first try success)
  completedSentences: string[];
  // Today's session state
  dailySession: {
    date: string; // YYYY-MM-DD
    queue: string[]; // sentence IDs for today's session
    currentIndex: number; // current position in queue
    attemptedWithMistake: string[]; // sentences where user made a mistake (can't be completed today)
  } | null;
}

const DEFAULT_RECALL: RecallState = {
  completedSentences: [],
  dailySession: null,
};

export async function GET(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const deckName = req.nextUrl.searchParams.get('deck');
    if (!deckName) return NextResponse.json({ error: 'deck param required' }, { status: 400 });
    const stored = await readUserJson<RecallState>(email, recallFile(deckName), DEFAULT_RECALL);
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
    const recallData: RecallState = body.data;

    if (!deck || typeof deck !== 'string' || !recallData || typeof recallData !== 'object') {
      return NextResponse.json({ error: 'deck and data are required' }, { status: 400 });
    }

    await writeUserJson(email, recallFile(deck), recallData);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const error = e as Error;
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Recall PUT error:', error);
    return NextResponse.json({ error: 'Failed to save recall data' }, { status: 500 });
  }
}
