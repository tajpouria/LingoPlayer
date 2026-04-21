'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Copy, Check, Loader2, AlertCircle } from 'lucide-react';
import { useDarkMode } from './DarkModeProvider';

// ── Types ────────────────────────────────────────────────────────────────────

interface Row {
  word: string;
  sentences: string[];
}

interface WordSRS {
  box: number;
  nextReviewDate: string;
  learnedDate: string;
}

interface DeckSRS {
  [word: string]: WordSRS;
}

interface SessionResult {
  date: string;
  sentencesAsked: number;
  correctFirstTry: number;
  correctWithRetry: number;
  failed: number;
  masteredSentences: string[];
  struggledSentences: string[];
}

interface RecallState {
  completedSentences: string[];
  sessionHistory: SessionResult[];
}

interface LingoRecallProps {
  deckName: string;
  data: Row[];
  srs: DeckSRS;
  onBack: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DAILY_RECALL_LIMIT = 25;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

// Generate a unique ID for a sentence
function sentenceId(word: string, sentenceIndex: number): string {
  return `${word}::${sentenceIndex}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LingoRecall({ deckName, data, srs, onBack }: LingoRecallProps) {
  const { isDark: _isDark } = useDarkMode();
  const [recallState, setRecallState] = useState<RecallState | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showResultsInput, setShowResultsInput] = useState(false);
  const [resultsJson, setResultsJson] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Save timer ref
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recallStateRef = useRef<RecallState | null>(null);
  recallStateRef.current = recallState;

  // ── Get daily sentences ───────────────────────────────────────────────────

  const dailySentences = useMemo(() => {
    const completedSet = new Set(recallState?.completedSentences || []);
    const sentences: { word: string; sentence: string; id: string }[] = [];
    
    for (const row of data) {
      // Only include sentences from words that are in box >= 1 (learned)
      const wordSRS = srs[row.word];
      if (!wordSRS || wordSRS.box < 1) continue;
      
      for (let i = 0; i < row.sentences.length; i++) {
        const id = sentenceId(row.word, i);
        if (!completedSet.has(id)) {
          sentences.push({ word: row.word, sentence: row.sentences[i], id });
        }
      }
    }
    
    // Shuffle and limit
    const shuffled = [...sentences].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, DAILY_RECALL_LIMIT);
  }, [data, srs, recallState?.completedSentences]);

  // ── Generate prompt text ──────────────────────────────────────────────────

  const promptText = useMemo(() => {
    const sentencesList = dailySentences.map(s => 
      `- ${s.word}: "${s.sentence}" [${s.word}::${data.find(r => r.word === s.word)?.sentences.indexOf(s.sentence)}]`
    ).join('\n');

    return `Act as my strict but encouraging Dutch Language Tutor.

I want to practice my Dutch writing through active recall. I will provide you with a vocabulary list where each target word is followed by a few example sentences in Dutch.

Here is how our session will work:

You will silently translate the Dutch example sentences into English.

You will pick one sentence at random and present me with the English translation, along with the required Dutch target word. (Example: Translate: "I use a blue pen." | Required word: gebruiken)

I will type my Dutch translation.

You will evaluate my translation.

Did I use the target word correctly?

Is the grammar, spelling, and word order correct?

If I am correct, praise me briefly and give me the next sentence.

If I make a mistake, gently explain the error, give me a hint, and ask me to try translating that same sentence again. Keep asking until I get it right.

Keep track of the sentences I struggle with and ask them again later in the session.

Rules:

Only ask me ONE sentence at a time.

Wait for my answer before moving on.

Do not give me the Dutch answer unless I fail three times or ask for the solution.

IMPORTANT: Always communicate with me in English. All instructions, feedback, hints, and explanations must be in English.

Practice all ${dailySentences.length} sentences. Start immediately with the first one.

At the END of the session, output a JSON summary:
\`\`\`json
{"date":"YYYY-MM-DD","correctFirstTry":0,"failed":0,"masteredSentences":[],"struggledSentences":[]}
\`\`\`
Use the sentence IDs in brackets below for masteredSentences (correct on first try) and struggledSentences (needed hints/retries).

Here is my data:

${sentencesList}`;
  }, [dailySentences, data]);

  // ── Fetch recall state ────────────────────────────────────────────────────

  useEffect(() => {
    async function fetchRecallState() {
      try {
        const res = await fetch(`/api/recall?deck=${encodeURIComponent(deckName)}`);
        if (!res.ok) throw new Error('Failed to fetch');
        const state = await res.json();
        
        // Migrate old state format if needed
        const newState: RecallState = {
          completedSentences: state.completedSentences || [],
          sessionHistory: state.sessionHistory || [],
        };
        setRecallState(newState);
      } catch (error) {
        console.error('Error fetching recall state:', error);
        setRecallState({
          completedSentences: [],
          sessionHistory: [],
        });
      } finally {
        setLoading(false);
      }
    }

    fetchRecallState();
  }, [deckName]);

  // ── Save recall state ─────────────────────────────────────────────────────

  function saveRecallState(state: RecallState) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch('/api/recall', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deck: deckName, data: state }),
      }).catch(console.error);
    }, 1000);
  }

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        if (recallStateRef.current) {
          fetch('/api/recall', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deck: deckName, data: recallStateRef.current }),
          }).catch(console.error);
        }
      }
    };
  }, [deckName]);

  // ── Copy prompt ───────────────────────────────────────────────────────────

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  }

  // ── Parse and save results ────────────────────────────────────────────────

  async function parseAndSaveResults() {
    setParseError(null);
    setSaving(true);
    
    try {
      // Extract JSON from the input (handle markdown code blocks)
      let jsonStr = resultsJson.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }
      
      const result: SessionResult = JSON.parse(jsonStr);
      
      // Validate required fields
      if (typeof result.sentencesAsked !== 'number' ||
          typeof result.correctFirstTry !== 'number' ||
          typeof result.correctWithRetry !== 'number' ||
          typeof result.failed !== 'number' ||
          !Array.isArray(result.masteredSentences) ||
          !Array.isArray(result.struggledSentences)) {
        throw new Error('Invalid JSON format. Please ensure all required fields are present.');
      }
      
      // Add date if missing
      if (!result.date) {
        result.date = todayStr();
      }
      
      // Update recall state
      const newCompletedSentences = [
        ...(recallState?.completedSentences || []),
        ...result.masteredSentences.filter(id => !(recallState?.completedSentences || []).includes(id)),
      ];
      
      const newState: RecallState = {
        completedSentences: newCompletedSentences,
        sessionHistory: [...(recallState?.sessionHistory || []), result],
      };
      
      setRecallState(newState);
      
      // Save immediately
      await fetch('/api/recall', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deck: deckName, data: newState }),
      });
      
      setSaveSuccess(true);
      setResultsJson('');
      setTimeout(() => {
        setSaveSuccess(false);
        setShowResultsInput(false);
      }, 2000);
      
    } catch (error) {
      console.error('Parse error:', error);
      setParseError(error instanceof Error ? error.message : 'Failed to parse JSON');
    } finally {
      setSaving(false);
    }
  }

  // ── Calculate stats ───────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const totalSentences = data.reduce((acc, row) => {
      const wordSRS = srs[row.word];
      if (!wordSRS || wordSRS.box < 1) return acc;
      return acc + row.sentences.length;
    }, 0);
    
    const completedCount = recallState?.completedSentences.length || 0;
    const sessionCount = recallState?.sessionHistory.length || 0;
    
    return {
      totalSentences,
      completedCount,
      sessionCount,
      remainingToday: dailySentences.length,
    };
  }, [data, srs, recallState, dailySentences]);

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (dailySentences.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] p-8">
        <div className="max-w-sm w-full text-center">
          <p className="font-serif text-3xl font-normal mb-2">All done</p>
          <p className="text-[var(--text-muted)] text-sm mb-2">
            {stats.completedCount} / {stats.totalSentences} sentences mastered
          </p>
          <button onClick={onBack} className="mt-8 text-sm underline text-[var(--text-primary)]">Back to menu</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Header */}
      <header className="px-8 py-4 flex justify-between items-center text-base text-[var(--text-muted)]">
        <button onClick={onBack} className="hover:text-[var(--text-primary)] transition-colors">← Back</button>
        <span>{stats.completedCount} / {stats.totalSentences} mastered</span>
      </header>

      <main className="flex-1 flex flex-col items-center px-8 py-6 overflow-auto">
        <div className="max-w-2xl w-full space-y-8">

          {/* Stats row */}
          <div className="flex gap-8 text-base border-b border-[var(--border-color)] pb-4">
            <div><span className="font-medium">{stats.remainingToday}</span> <span className="text-[var(--text-muted)]">today</span></div>
            <div><span className="font-medium">{stats.completedCount}</span> <span className="text-[var(--text-muted)]">mastered</span></div>
            <div><span className="font-medium">{stats.sessionCount}</span> <span className="text-[var(--text-muted)]">sessions</span></div>
          </div>

          {/* Prompt section */}
          <div>
            <div className="flex justify-between items-center mb-3">
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-widest">Tutor prompt</p>
              <button
                onClick={copyPrompt}
                className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
              </button>
            </div>
              <pre className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-auto border-l-2 border-[var(--border-color)] pl-4">
              {promptText}
            </pre>
          </div>

          {/* Results input */}
          <div className="border-t border-[var(--border-color)] pt-6">
            {!showResultsInput ? (
              <button
                onClick={() => setShowResultsInput(true)}
                className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                + Paste session results
              </button>
            ) : (
              <AnimatePresence>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="space-y-4"
                >
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-[var(--text-muted)] uppercase tracking-widest">Session results JSON</p>
                    <button
                      onClick={() => { setShowResultsInput(false); setResultsJson(''); setParseError(null); }}
                      className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                  <textarea
                    value={resultsJson}
                    onChange={(e) => { setResultsJson(e.target.value); setParseError(null); }}
                    placeholder="Paste JSON here..."
                    className="w-full bg-transparent border border-[var(--border-color)] focus:border-[var(--text-primary)] outline-none p-3 text-base font-mono min-h-[120px] resize-none transition-colors placeholder:text-[var(--text-muted)]"
                  />
                  {parseError && (
                    <div className="flex items-start gap-2 text-sm text-[var(--text-muted)]">
                      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span>{parseError}</span>
                    </div>
                  )}
                  {saveSuccess && (
                    <p className="text-sm text-[var(--text-muted)]">
                      <Check className="w-4 h-4 inline mr-1" />Saved
                    </p>
                  )}
                  <button
                    onClick={parseAndSaveResults}
                    disabled={!resultsJson.trim() || saving}
                    className="text-base underline text-[var(--text-primary)] disabled:opacity-30 flex items-center gap-1"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Save results
                  </button>
                </motion.div>
              </AnimatePresence>
            )}
          </div>

        </div>
      </main>
    </div>
  );
}
