import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { verifyToken } from '@/src/lib/jwt';
import { getNextGeminiApiKey } from '@/src/lib/env';

async function getEmail(req: NextRequest): Promise<string> {
  const token = req.cookies.get('token')?.value;
  if (!token) throw new Error('Unauthorized');
  const { email } = await verifyToken(token);
  return email;
}

interface TranslateRequest {
  text: string;
  from?: string;
  to?: string;
}

export async function POST(req: NextRequest) {
  try {
    // Verify authentication
    await getEmail(req);

    const body: TranslateRequest = await req.json();
    const { text, from = 'Dutch', to = 'English' } = body;

    if (!text) {
      return NextResponse.json(
        { error: 'Missing required field: text' },
        { status: 400 }
      );
    }

    const ai = new GoogleGenAI({ apiKey: getNextGeminiApiKey() });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: `Translate the following ${from} text to ${to}. Only respond with the translation, nothing else.\n\n"${text}"`,
    });

    const translation = response.text?.trim() || '';
    
    // Remove quotes if the model wrapped the response in them
    const cleanTranslation = translation.replace(/^["']|["']$/g, '');

    return NextResponse.json({ translation: cleanTranslation });
  } catch (e: unknown) {
    const error = e as Error;
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Translation error:', error);
    return NextResponse.json(
      { error: 'Failed to translate' },
      { status: 500 }
    );
  }
}
