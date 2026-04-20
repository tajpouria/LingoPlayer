import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { verifyToken } from '@/src/lib/jwt';
import { getNextGeminiApiKey } from '@/src/lib/env';

async function getEmail(req: NextRequest): Promise<string> {
  const token = req.cookies.get('token')?.value;
  if (!token) throw new Error('Unauthorized');
  const { email } = await verifyToken(token);
  return email;
}

interface EvaluationRequest {
  userInput: string;
  targetSentence: string;
  englishTranslation: string;
  targetWord: string;
}

interface EvaluationResponse {
  isCorrect: boolean;
  message: string;
  hint?: string;
}

export async function POST(req: NextRequest) {
  try {
    // Verify authentication
    await getEmail(req);

    const body: EvaluationRequest = await req.json();
    const { userInput, targetSentence, englishTranslation, targetWord } = body;

    if (!userInput || !targetSentence || !englishTranslation || !targetWord) {
      return NextResponse.json(
        { error: 'Missing required fields: userInput, targetSentence, englishTranslation, targetWord' },
        { status: 400 }
      );
    }

    // Shallow check to save AI costs
    const normalize = (text: string) => {
      return text
        .toLowerCase()
        .replace(/[.,!?;:"'()]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const normalizedInput = normalize(userInput);
    const normalizedTarget = normalize(targetSentence);

    if (normalizedInput === normalizedTarget) {
      const result: EvaluationResponse = {
        isCorrect: true,
        message: 'Perfect! You nailed the translation exactly as expected.',
      };
      return NextResponse.json(result);
    }

    // Use AI evaluation for more nuanced checking
    const ai = new GoogleGenAI({ apiKey: getNextGeminiApiKey() });
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents: `User translation: "${userInput}"`,
      config: {
        systemInstruction: `You are an expert Dutch language tutor helping a student learn through active recall.
Your task is to evaluate a user's Dutch translation of an English sentence.

Target sentence to match: "${targetSentence}"
English meaning: "${englishTranslation}"
Required Dutch word to use: "${targetWord}" (can be conjugated correctly).

Evaluation rules:
1. Check if the exact target word (or its grammatically correct conjugated form) is present.
2. Check for perfect Dutch grammar, spelling, and natural word order.
3. Even if the user says something slightly different from the target sentence but it's grammatically correct and uses the target word, consider it correct IF it has the same meaning.

IMPORTANT: Do NOT reveal the correct Dutch sentence in your response. The user must learn by trying again.

Language Constraint: All feedback in the 'message' and 'hint' fields MUST be written in English.

Return your evaluation in JSON format with the following fields:
- isCorrect (boolean): true if the translation is accurate and uses the target word correctly.
- message (string): brief praise if correct. If incorrect, explain what's wrong without giving away the answer (e.g., "The word order needs adjustment" or "Check your verb conjugation").
- hint (string, REQUIRED if incorrect): provide a helpful hint that guides them toward the answer without revealing it. Examples: "Think about where the verb should go in Dutch", "The article should match the gender of the noun", "Consider using a different preposition".`,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isCorrect: { type: Type.BOOLEAN },
            message: { type: Type.STRING },
            hint: { type: Type.STRING },
          },
          required: ['isCorrect', 'message'],
        },
      },
    });

    const result = JSON.parse(response.text || '{}') as EvaluationResponse;
    return NextResponse.json(result);
  } catch (e: unknown) {
    const error = e as Error;
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('LLM evaluation error:', error);
    return NextResponse.json(
      { error: 'Failed to evaluate translation' },
      { status: 500 }
    );
  }
}
