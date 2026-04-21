'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Copy, 
  Check,
  ArrowLeft,
  Moon,
  Sun,
  Loader2,
  ClipboardPaste,
  Save,
  Brain,
  AlertCircle
} from 'lucide-react';
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
  const { isDark, toggle: toggleDarkMode } = useDarkMode();
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
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 dark:bg-zinc-950">
        <Loader2 className="w-12 h-12 animate-spin text-zinc-400 mb-4" />
        <p className="text-zinc-500 dark:text-zinc-400">Loading Lingo Recall...</p>
      </div>
    );
  }

  // ── No sentences available ────────────────────────────────────────────────

  if (dailySentences.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 p-6">
        <div className="max-w-md w-full text-center">
          <div className="text-6xl mb-6">✨</div>
          <h2 className="text-2xl font-bold mb-2">All Done!</h2>
          <p className="text-zinc-500 dark:text-zinc-400 mb-4">
            You've mastered all available sentences. Great job!
          </p>
          <p className="text-zinc-400 dark:text-zinc-500 text-sm mb-8">
            Total mastered: {stats.completedCount} / {stats.totalSentences}
          </p>
          <button 
            onClick={onBack} 
            className="w-full py-4 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-2xl font-medium"
          >
            Back to menu
          </button>
        </div>
      </div>
    );
  }

  // ── Main view ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-sans">
      {/* Header */}
      <header className="p-6 flex justify-between items-center">
        <div>
          <button 
            onClick={onBack}
            className="flex items-center gap-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 mb-1 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
          <h1 className="text-xs font-bold uppercase tracking-widest text-zinc-400">
            {deckName}
          </h1>
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            Lingo Recall
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggleDarkMode} className="p-2 rounded-full hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors">
            {isDark ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-zinc-500" />}
          </button>
          <span className="text-xs px-2.5 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 font-semibold flex items-center gap-1">
            <Brain className="w-3 h-3" />
            Recall
          </span>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center px-6 py-8 overflow-auto">
        <div className="max-w-2xl w-full space-y-6">
          {/* Stats card */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl p-5 border border-zinc-100 dark:border-zinc-800 shadow-sm">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{stats.remainingToday}</p>
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Today's Sentences</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{stats.completedCount}</p>
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Mastered</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{stats.sessionCount}</p>
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Sessions</p>
              </div>
            </div>
          </div>

          {/* Instructions */}
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-2xl p-5 border border-blue-100 dark:border-blue-800">
            <h3 className="font-semibold text-blue-900 dark:text-blue-300 mb-2">How to use</h3>
            <ol className="text-sm text-blue-800 dark:text-blue-300 space-y-1.5 list-decimal list-inside">
              <li>Copy the prompt below</li>
              <li>Paste it into ChatGPT, Claude, or your preferred AI</li>
              <li>Practice your Dutch translations in the conversation</li>
              <li>When done, copy the JSON summary the AI provides</li>
              <li>Paste it here to save your progress</li>
            </ol>
          </div>

          {/* Prompt section */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-100 dark:border-zinc-800 shadow-sm overflow-hidden">
            <div className="p-4 border-b border-zinc-100 dark:border-zinc-800 flex justify-between items-center">
              <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                Tutor Prompt
              </p>
              <button
                onClick={copyPrompt}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-lg font-medium text-sm hover:bg-zinc-800 dark:hover:bg-zinc-200 active:scale-[0.98] transition-all"
              >
                {copied ? (
                  <>
                    <Check className="w-4 h-4" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    Copy Prompt
                  </>
                )}
              </button>
            </div>
            <div className="p-4 max-h-96 overflow-auto">
              <pre className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
                {promptText}
              </pre>
            </div>
          </div>

          {/* Results input section */}
          <AnimatePresence>
            {!showResultsInput ? (
              <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowResultsInput(true)}
                className="w-full py-4 border-2 border-dashed border-zinc-200 dark:border-zinc-700 rounded-2xl text-zinc-500 dark:text-zinc-400 hover:border-zinc-400 dark:hover:border-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-all flex items-center justify-center gap-2 font-medium"
              >
                <ClipboardPaste className="w-5 h-5" />
                Paste Session Results
              </motion.button>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-100 dark:border-zinc-800 shadow-sm overflow-hidden"
              >
                <div className="p-4 border-b border-zinc-100 dark:border-zinc-800 flex justify-between items-center">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                    Paste Session Results JSON
                  </p>
                  <button
                    onClick={() => {
                      setShowResultsInput(false);
                      setResultsJson('');
                      setParseError(null);
                    }}
                    className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-sm"
                  >
                    Cancel
                  </button>
                </div>
                <div className="p-4 space-y-4">
                  <textarea
                    value={resultsJson}
                    onChange={(e) => {
                      setResultsJson(e.target.value);
                      setParseError(null);
                    }}
                    placeholder='Paste the JSON here (including ```json blocks is fine)...'
                    className="w-full bg-zinc-50 dark:bg-zinc-800 border-2 border-zinc-200 dark:border-zinc-700 focus:border-zinc-400 dark:focus:border-zinc-500 rounded-xl p-4 text-sm font-mono outline-none transition-colors min-h-[150px] resize-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600"
                  />
                  
                  {parseError && (
                    <div className="flex items-start gap-2 text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-900/20 p-3 rounded-xl">
                      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span>{parseError}</span>
                    </div>
                  )}
                  
                  {saveSuccess && (
                    <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-sm bg-emerald-50 dark:bg-emerald-900/20 p-3 rounded-xl">
                      <Check className="w-4 h-4" />
                      <span>Results saved successfully!</span>
                    </div>
                  )}
                  
                  <button
                    onClick={parseAndSaveResults}
                    disabled={!resultsJson.trim() || saving}
                    className="w-full py-3 bg-emerald-600 text-white rounded-xl font-medium hover:bg-emerald-700 active:scale-[0.98] transition-all disabled:bg-zinc-300 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {saving ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        <Save className="w-5 h-5" />
                        Save Results
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Footer */}
      <footer className="p-6 text-center">
        <div className="flex items-center justify-center gap-6 text-[10px] font-bold uppercase tracking-widest text-zinc-400">
          <div className="flex items-center gap-1.5">
            <span>Progress: {stats.completedCount} / {stats.totalSentences}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
