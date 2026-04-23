import { NextRequest, NextResponse } from 'next/server';
import { read, utils } from 'xlsx';
import { verifyToken } from '@/src/lib/jwt';
import { writeUserJson } from '@/src/lib/s3';

interface Row { word: string; sentences: string[]; }

async function getEmail(req: NextRequest): Promise<string> {
  const token = req.cookies.get('token')?.value;
  if (!token) throw new Error('Unauthorized');
  const { email } = await verifyToken(token);
  return email;
}

function deckFile(deckName: string): string {
  return `deck-data-${deckName.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

export async function POST(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const deckName = form.get('deck') as string | null;

    if (!file || !deckName) {
      return NextResponse.json({ error: 'file and deck are required' }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const wb = read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];

    const rows: Row[] = raw
      .filter(r => Array.isArray(r) && r.length > 0 && r[0] != null && String(r[0]).trim())
      .map(r => ({
        word: String((r as unknown[])[0]).trim(),
        sentences: (r as unknown[]).slice(1)
          .filter(c => c != null && String(c).trim())
          .map(c => String(c).trim()),
      }));

    await writeUserJson(email, deckFile(deckName), rows);
    return NextResponse.json({ rows });
  } catch (e: any) {
    if (e.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Import error:', e);
    return NextResponse.json({ error: 'Failed to import' }, { status: 500 });
  }
}
