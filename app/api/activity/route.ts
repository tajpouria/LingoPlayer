import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/src/lib/jwt';
import { readUserJson } from '@/src/lib/s3';

interface Deck { name: string; url: string; }
interface WordSRS { box: number; nextReviewDate: string; learnedDate: string; }
interface DeckSRS { [word: string]: WordSRS; }

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

    const decks = await readUserJson<Deck[]>(email, 'decks.json', []);

    const activity: Record<string, number> = {};

    await Promise.all(decks.map(async (deck) => {
      const stored = await readUserJson<{ key: string; data: DeckSRS }>(
        email, srsFile(deck.name), { key: '', data: {} }
      );
      const srs: DeckSRS = (stored as { key: string; data: DeckSRS }).data ?? (stored as unknown as DeckSRS);
      for (const word of Object.values(srs)) {
        if (word?.learnedDate) {
          activity[word.learnedDate] = (activity[word.learnedDate] || 0) + 1;
        }
      }
    }));

    // Calculate streak (consecutive days going back from today)
    let streak = 0;
    const d = new Date();
    while (true) {
      const dateStr = d.toISOString().split('T')[0];
      if (activity[dateStr]) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }

    const totalDays = Object.keys(activity).length;

    return NextResponse.json({ activity, streak, totalDays });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
