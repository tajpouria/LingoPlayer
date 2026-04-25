import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/src/lib/jwt';
import { readUserText, writeUserText, readUserJson } from '@/src/lib/s3';

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

function safeName(deckName: string): string {
  return deckName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function csvFile(deckName: string): string {
  return `deck-data-${safeName(deckName)}.csv`;
}

function jsonFile(deckName: string): string {
  return `deck-data-${safeName(deckName)}.json`;
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function rowsToCsv(rows: Row[]): string {
  return rows
    .map(r => [r.word, ...r.sentences].map(escapeCsv).join(','))
    .join('\n');
}

function csvToRows(csv: string): Row[] {
  return csv
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .map(line => {
      const parts = parseCsvLine(line);
      return { word: parts[0] ?? '', sentences: parts.slice(1).filter(s => s.length > 0) };
    })
    .filter(r => r.word.trim().length > 0);
}

export async function GET(req: NextRequest) {
  try {
    const email = await getEmail(req);
    const deck = req.nextUrl.searchParams.get('deck');
    if (!deck) return NextResponse.json({ error: 'deck is required' }, { status: 400 });

    const csv = await readUserText(email, csvFile(deck));
    if (csv !== null) {
      return NextResponse.json(csvToRows(csv));
    }

    // Migrate legacy JSON file if CSV doesn't exist yet
    const legacy = await readUserJson<Row[]>(email, jsonFile(deck), []);
    return NextResponse.json(legacy);
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
      .map((r: Row) => ({ word: String(r.word).trim(), sentences: (r.sentences || []).map(String).filter(s => s.trim()) }));

    await writeUserText(email, csvFile(deck), rowsToCsv(clean), 'text/csv');
    return NextResponse.json({ ok: true, count: clean.length });
  } catch (e: any) {
    if (e.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
}
