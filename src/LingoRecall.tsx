'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  CheckCircle2, 
  ChevronRight, 
  Brain, 
  XCircle,
  Trophy,
  Loader2,
  ArrowLeft,
  Moon,
  Sun
} from 'lucide-react';
import { useDarkMode } from './DarkModeProvider';

// ── Types ────────────────────────────────────────────────────────────────────

interface Row {
  word: string;
  sentences: string[];
}

interface Feedback {
  isCorrect: boolean;
  message: string;
  hint?: string;
}

interface WordSRS {
  box: number;
  nextReviewDate: string;
  learnedDate: string;
}

interface DeckSRS {
  [word: string]: WordSRS;
}

interface RecallState {
  completedSentences: string[];
  dailySession: {
    date: string;
    queue: string[];
    currentIndex: number;
    attemptedWithMistake: string[];
  } | null;
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

// Parse sentence ID back to word and index
function parseSentenceId(id: string): { word: string; sentenceIndex: number } {
  const [word, idx] = id.split('::');
  return { word, sentenceIndex: parseInt(idx, 10) };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LingoRecall({ deckName, data, srs, onBack }: LingoRecallProps) {
  const { isDark, toggle: toggleDarkMode } = useDarkMode();
  const [recallState, setRecallState] = useState<RecallState | null>(null);
  const [loading, setLoading] = useState(true);
  const [userInput, setUserInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [englishTranslation, setEnglishTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);

  // Save timer ref
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recallStateRef = useRef<RecallState | null>(null);
  recallStateRef.current = recallState;

  // ── Fetch recall state ────────────────────────────────────────────────────

  useEffect(() => {
    async function fetchRecallState() {
      try {
        const res = await fetch(`/api/recall?deck=${encodeURIComponent(deckName)}`);
        if (!res.ok) throw new Error('Failed to fetch');
        const state: RecallState = await res.json();
        
        const today = todayStr();
        
        // Check if we have a session for today
        if (state.dailySession && state.dailySession.date === today) {
          // Check if session is complete (all items processed)
          if (state.dailySession.currentIndex >= state.dailySession.queue.length) {
            setSessionComplete(true);
          }
          setRecallState(state);
        } else {
          // Create new daily session
          const allSentenceIds = generateAllSentenceIds(data, state.completedSentences);
          const dailyQueue = selectDailyQueue(allSentenceIds, DAILY_RECALL_LIMIT);
          
          if (dailyQueue.length === 0) {
            // All sentences completed!
            setSessionComplete(true);
            setRecallState(state);
          } else {
            const newState: RecallState = {
              completedSentences: state.completedSentences,
              dailySession: {
                date: today,
                queue: dailyQueue,
                currentIndex: 0,
                attemptedWithMistake: [],
              },
            };
            setRecallState(newState);
            saveRecallState(newState);
          }
        }
      } catch (error) {
        console.error('Error fetching recall state:', error);
        // Initialize with empty state
        const allSentenceIds = generateAllSentenceIds(data, []);
        const dailyQueue = selectDailyQueue(allSentenceIds, DAILY_RECALL_LIMIT);
        
        const newState: RecallState = {
          completedSentences: [],
          dailySession: {
            date: todayStr(),
            queue: dailyQueue,
            currentIndex: 0,
            attemptedWithMistake: [],
          },
        };
        setRecallState(newState);
      } finally {
        setLoading(false);
      }
    }

    fetchRecallState();
  }, [deckName, data, srs]);

  // ── Generate all possible sentence IDs (only from learned words) ──────────

  function generateAllSentenceIds(rows: Row[], completedIds: string[]): string[] {
    const completedSet = new Set(completedIds);
    const ids: string[] = [];
    
    for (const row of rows) {
      // Only include sentences from words that are in box >= 1 (learned)
      const wordSRS = srs[row.word];
      if (!wordSRS || wordSRS.box < 1) continue;
      
      for (let i = 0; i < row.sentences.length; i++) {
        const id = sentenceId(row.word, i);
        if (!completedSet.has(id)) {
          ids.push(id);
        }
      }
    }
    
    return ids;
  }

  // ── Select daily queue (prioritize higher boxes) ──────────────────────────

  function selectDailyQueue(ids: string[], limit: number): string[] {
    // Group sentence IDs by their word's box level
    const idsByBox: Map<number, string[]> = new Map();
    
    for (const id of ids) {
      const { word } = parseSentenceId(id);
      const wordSRS = srs[word];
      const box = wordSRS?.box ?? 0;
      
      if (!idsByBox.has(box)) {
        idsByBox.set(box, []);
      }
      idsByBox.get(box)!.push(id);
    }
    
    // Sort boxes in descending order (highest first)
    const sortedBoxes = Array.from(idsByBox.keys()).sort((a, b) => b - a);
    
    // Build queue prioritizing higher boxes
    const queue: string[] = [];
    for (const box of sortedBoxes) {
      if (queue.length >= limit) break;
      
      const boxIds = idsByBox.get(box)!;
      // Shuffle within each box level
      const shuffled = [...boxIds].sort(() => Math.random() - 0.5);
      
      for (const id of shuffled) {
        if (queue.length >= limit) break;
        queue.push(id);
      }
    }
    
    return queue;
  }

  // ── Save recall state ─────────────────────────────────────────────────────

  function saveRecallState(state: RecallState) {
    // Debounce saves
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

  // ── Get current sentence info ─────────────────────────────────────────────

  const currentSentence = useMemo(() => {
    if (!recallState?.dailySession) return null;
    const { queue, currentIndex } = recallState.dailySession;
    if (currentIndex >= queue.length) return null;
    
    const id = queue[currentIndex];
    const { word, sentenceIndex } = parseSentenceId(id);
    const row = data.find(r => r.word === word);
    if (!row || !row.sentences[sentenceIndex]) return null;
    
    return {
      id,
      word,
      sentence: row.sentences[sentenceIndex],
    };
  }, [recallState, data]);

  // ── Fetch English translation ─────────────────────────────────────────────

  useEffect(() => {
    if (!currentSentence) {
      setEnglishTranslation(null);
      return;
    }

    setTranslating(true);
    setEnglishTranslation(null);

    fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: currentSentence.sentence,
        from: 'Dutch',
        to: 'English',
      }),
    })
      .then(res => res.json())
      .then(data => {
        setEnglishTranslation(data.translation || null);
      })
      .catch(console.error)
      .finally(() => setTranslating(false));
  }, [currentSentence?.id]);

  // ── Submit answer ─────────────────────────────────────────────────────────

  async function submitAnswer() {
    if (!userInput.trim() || !currentSentence || !recallState?.dailySession) return;

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userInput: userInput.trim(),
          targetSentence: currentSentence.sentence,
          englishTranslation: englishTranslation || `Sentence using "${currentSentence.word}"`,
          targetWord: currentSentence.word,
        }),
      });

      if (!res.ok) {
        throw new Error('Evaluation failed');
      }

      const result: Feedback = await res.json();
      setFeedback(result);

      // Update state based on result
      const { dailySession, completedSentences } = recallState;
      const hasAlreadyMadeError = dailySession.attemptedWithMistake.includes(currentSentence.id);

      if (result.isCorrect && !hasAlreadyMadeError) {
        // First try success - mark as completed permanently
        const newCompletedSentences = [...completedSentences, currentSentence.id];
        const newState: RecallState = {
          ...recallState,
          completedSentences: newCompletedSentences,
        };
        setRecallState(newState);
        saveRecallState(newState);
      } else if (!result.isCorrect && !hasAlreadyMadeError) {
        // First mistake - mark as attempted with mistake
        const newAttemptedWithMistake = [...dailySession.attemptedWithMistake, currentSentence.id];
        const newState: RecallState = {
          ...recallState,
          dailySession: {
            ...dailySession,
            attemptedWithMistake: newAttemptedWithMistake,
          },
        };
        setRecallState(newState);
        saveRecallState(newState);
      }
    } catch (error) {
      console.error('Submission error:', error);
      setFeedback({
        isCorrect: false,
        message: 'Something went wrong. Please try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── Move to next sentence ─────────────────────────────────────────────────

  function nextSentence() {
    if (!recallState?.dailySession) return;

    const newIndex = recallState.dailySession.currentIndex + 1;
    
    if (newIndex >= recallState.dailySession.queue.length) {
      setSessionComplete(true);
    }

    const newState: RecallState = {
      ...recallState,
      dailySession: {
        ...recallState.dailySession,
        currentIndex: newIndex,
      },
    };
    
    setRecallState(newState);
    saveRecallState(newState);
    setUserInput('');
    setFeedback(null);
    setEnglishTranslation(null);
  }

  // ── Calculate stats ───────────────────────────────────────────────────────

  const stats = useMemo(() => {
    if (!recallState?.dailySession) {
      return { completed: 0, total: 0, perfectToday: 0 };
    }
    
    const { queue, currentIndex, attemptedWithMistake } = recallState.dailySession;
    const completedSet = new Set(recallState.completedSentences);
    
    // Count how many were completed today (first try success)
    const perfectToday = queue.slice(0, currentIndex).filter(id => 
      completedSet.has(id) && !attemptedWithMistake.includes(id)
    ).length;
    
    return {
      completed: currentIndex,
      total: queue.length,
      perfectToday,
    };
  }, [recallState]);

  const progress = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0;

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 dark:bg-zinc-950">
        <Loader2 className="w-12 h-12 animate-spin text-zinc-400 mb-4" />
        <p className="text-zinc-500 dark:text-zinc-400">Loading Lingo Recall...</p>
      </div>
    );
  }

  // ── Session complete ──────────────────────────────────────────────────────

  if (sessionComplete) {
    const totalCompleted = recallState?.completedSentences.length || 0;
    const allSentences = data.reduce((acc, row) => acc + row.sentences.length, 0);
    const overallProgress = allSentences > 0 ? (totalCompleted / allSentences) * 100 : 0;

    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 p-6">
        <div className="max-w-md w-full text-center">
          <div className="text-6xl mb-6">🎯</div>
          <h2 className="text-2xl font-bold mb-2">Session Complete!</h2>
          <p className="text-zinc-500 mb-4">
            {stats.perfectToday > 0 
              ? `You mastered ${stats.perfectToday} sentence${stats.perfectToday !== 1 ? 's' : ''} today!`
              : "Great practice session!"}
          </p>
          
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-100 dark:border-zinc-800 p-4 mb-8">
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-3">
              Overall Progress
            </p>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full"
                  style={{ width: `${overallProgress}%` }}
                />
              </div>
              <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                {totalCompleted} / {allSentences}
              </span>
            </div>
          </div>

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

  // ── No sentences available ────────────────────────────────────────────────

  if (!currentSentence) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 p-6">
        <div className="max-w-md w-full text-center">
          <div className="text-6xl mb-6">✨</div>
          <h2 className="text-2xl font-bold mb-2">All Done!</h2>
          <p className="text-zinc-500 dark:text-zinc-400 mb-8">
            You've completed all available sentences. Great job!
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

  // ── Active session ────────────────────────────────────────────────────────

  const hasError = recallState?.dailySession?.attemptedWithMistake.includes(currentSentence.id);

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
            {stats.completed + 1} / {stats.total} · Lingo Recall
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
            <Trophy className="w-3 h-3" />
            {stats.perfectToday}
          </span>
          <button onClick={toggleDarkMode} className="p-2 rounded-full hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors">
            {isDark ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-zinc-500" />}
          </button>
          <span className="text-xs px-2.5 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 font-semibold flex items-center gap-1">
            <Brain className="w-3 h-3" />
            Recall
          </span>
        </div>
      </header>

      {/* Progress bar */}
      <div className="h-1 bg-zinc-100 dark:bg-zinc-800 mx-6 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-emerald-500 rounded-full"
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.4 }}
        />
      </div>

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentSentence.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
            className="max-w-lg w-full space-y-6"
          >
            {/* English sentence to translate */}
            <div className="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-zinc-100 dark:border-zinc-800 shadow-sm space-y-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                Translate this sentence
              </p>
              {translating ? (
                <div className="flex items-center gap-2 text-zinc-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Loading...</span>
                </div>
              ) : englishTranslation ? (
                <h2 className="text-2xl font-serif italic leading-relaxed text-zinc-800 dark:text-zinc-200">
                  &ldquo;{englishTranslation}&rdquo;
                </h2>
              ) : (
                <p className="text-zinc-400 italic">Translation unavailable</p>
              )}
              
              <div className="flex items-center gap-3 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                  Required word:
                </span>
                <code className="bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1.5 rounded-lg text-sm font-mono">
                  {currentSentence.word}
                </code>
                {hasError && (
                  <span className="text-xs px-2 py-1 rounded-full bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-medium">
                    Already attempted
                  </span>
                )}
              </div>
            </div>

            {/* Input section */}
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-2">
                  Your Dutch Translation
                </label>
                <textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  disabled={isSubmitting || feedback?.isCorrect}
                  placeholder="Typ je antwoord hier..."
                  className="w-full bg-white dark:bg-zinc-900 border-2 border-zinc-200 dark:border-zinc-700 focus:border-zinc-400 dark:focus:border-zinc-500 rounded-xl p-4 text-lg outline-none transition-colors min-h-[100px] resize-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600 disabled:opacity-50"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (!feedback?.isCorrect && userInput.trim() && !translating && englishTranslation) submitAnswer();
                    }
                  }}
                />
              </div>

              {!feedback?.isCorrect && (
                <button
                  onClick={submitAnswer}
                  disabled={isSubmitting || !userInput.trim() || translating || !englishTranslation}
                  className="w-full py-3.5 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-xl font-medium shadow-lg shadow-zinc-200 dark:shadow-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 active:scale-[0.98] transition-all disabled:bg-zinc-300 dark:disabled:bg-zinc-700 disabled:shadow-none cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <div className="w-5 h-5 border-2 border-white/30 dark:border-zinc-900/30 border-t-white dark:border-t-zinc-900 rounded-full animate-spin" />
                  ) : (
                    <>
                      <CheckCircle2 className="w-5 h-5" />
                      Check Answer
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Feedback section */}
            <AnimatePresence>
              {feedback && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className={`rounded-2xl p-5 space-y-3 ${
                    feedback.isCorrect 
                      ? 'bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800' 
                      : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800'
                  }`}>
                    <div className="flex items-center gap-2">
                      {feedback.isCorrect ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <XCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                      )}
                      <span className={`text-[10px] font-bold uppercase tracking-widest ${
                        feedback.isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                      }`}>
                        {feedback.isCorrect 
                          ? (hasError ? 'Correct! (Already attempted)' : 'Perfect! +1 Mastered') 
                          : 'Not quite right'}
                      </span>
                    </div>
                    
                    <p className={`text-sm leading-relaxed ${
                      feedback.isCorrect ? 'text-emerald-800 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-300'
                    }`}>
                      {feedback.message}
                    </p>

                    {!feedback.isCorrect && feedback.hint && (
                      <div className="bg-white/60 dark:bg-zinc-800/60 p-3 rounded-xl">
                        <p className="text-[10px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-widest mb-1 opacity-60">
                          Hint
                        </p>
                        <p className="text-sm text-amber-900 dark:text-amber-200 italic">
                          {feedback.hint}
                        </p>
                      </div>
                    )}

                    {feedback.isCorrect ? (
                      <button
                        onClick={nextSentence}
                        className="flex items-center gap-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-6 py-2.5 rounded-xl font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 active:scale-[0.98] transition-all w-fit"
                      >
                        Next
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    ) : (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setFeedback(null)}
                          className="flex items-center gap-2 bg-amber-600 text-white px-6 py-2.5 rounded-xl font-medium hover:bg-amber-700 active:scale-[0.98] transition-all"
                        >
                          Try Again
                        </button>
                        <button
                          onClick={nextSentence}
                          className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 px-4 py-2.5 text-sm font-medium transition-all"
                        >
                          Skip for now
                        </button>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Footer stats */}
      <footer className="p-6 text-center">
        <div className="flex items-center justify-center gap-6 text-[10px] font-bold uppercase tracking-widest text-zinc-400">
          <div className="flex items-center gap-1.5">
            <Trophy className="w-3 h-3" />
            <span>Mastered Today: {stats.perfectToday}</span>
          </div>
          <div className="bg-zinc-200 dark:bg-zinc-700 w-px h-3" />
          <div className="flex items-center gap-1.5">
            <span>Total Mastered: {recallState?.completedSentences.length || 0}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
