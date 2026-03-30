/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SkipForward, SkipBack, Volume2, Loader2, Settings2, BookOpen, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// ── Types ────────────────────────────────────────────────────────────────────

interface Row {
  word: string;
  sentences: string[];
}

interface Deck {
  name: string;
  url: string;
}

interface WordSRS {
  box: number;            // 1–5
  nextReviewDate: string; // YYYY-MM-DD
  learnedDate: string;    // YYYY-MM-DD
}

interface DeckSRS {
  [word: string]: WordSRS;
}

type SessionMode = 'learn' | 'review';

// ── Constants ─────────────────────────────────────────────────────────────────

const DECKS: Deck[] = [
  {
    name: 'TaalCompleet - A1',
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRe6opl5ppH_B3r6TIKO0hVNiHkB2By-RuY1kH1sJQG4wHscGtlrxG_UMjWj-RjlxvFjwkBmBFE69Qb/pub?output=tsv',
  },
];

// Box index → review interval in days
// Box 1: every day · Box 2: every 3 days · Box 3: every week
// Box 4: every 2 weeks · Box 5: once a month
const BOX_INTERVALS = [0, 1, 3, 7, 14, 30];
const DAILY_NEW_LIMIT = 25;

// ── SRS helpers ───────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function loadSRS(deckName: string): DeckSRS {
  try {
    const raw = localStorage.getItem(`srs_${deckName}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSRS(deckName: string, srs: DeckSRS): void {
  localStorage.setItem(`srs_${deckName}`, JSON.stringify(srs));
}

function getNewWords(data: Row[], srs: DeckSRS): Row[] {
  const today = todayStr();
  const learnedToday = (Object.values(srs) as WordSRS[]).filter(w => w.learnedDate === today).length;
  const remaining = Math.max(0, DAILY_NEW_LIMIT - learnedToday);
  if (remaining === 0) return [];
  return data.filter(row => !srs[row.word]).slice(0, remaining);
}

function getDueWords(data: Row[], srs: DeckSRS): Row[] {
  const today = todayStr();
  return data.filter(row => {
    const w = srs[row.word];
    return w && w.box >= 1 && w.nextReviewDate <= today;
  });
}

// Advance a word to the next box (always "correct" — just listened to it)
function promoteWord(srs: DeckSRS, word: string, isNewWord: boolean): DeckSRS {
  const today = todayStr();
  const existing = srs[word];
  const currentBox = isNewWord ? 0 : (existing?.box ?? 1);
  const newBox = Math.min(5, currentBox + 1);
  return {
    ...srs,
    [word]: {
      box: newBox,
      nextReviewDate: addDays(BOX_INTERVALS[newBox]),
      learnedDate: existing?.learnedDate ?? today,
    },
  };
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  // Deck & data
  const [selectedDeckIndex, setSelectedDeckIndex] = useState<number | null>(null);
  const [data, setData] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [srs, setSRS] = useState<DeckSRS>({});

  // Session
  const [sessionMode, setSessionMode] = useState<SessionMode | null>(null);
  const [sessionWords, setSessionWords] = useState<Row[]>([]);
  const [sessionIndex, setSessionIndex] = useState(0);
  const [isSessionComplete, setIsSessionComplete] = useState(false);
  // Track which session word indices have already been promoted (so back+forward doesn't double-promote)
  const promotedRef = useRef<Set<number>>(new Set());

  // Player
  const [itemIndex, setItemIndex] = useState(-1); // -1 = word, 0+ = sentence
  const [isPlaying, setIsPlaying] = useState(false);
  const [delay, setDelay] = useState(3);
  const [lang, setLang] = useState('nl');
  const [showSettings, setShowSettings] = useState(false);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Keep a ref to current srs so the async player loop always reads fresh state
  const srsRef = useRef<DeckSRS>(srs);
  srsRef.current = srs;

  // ── Fetch data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (selectedDeckIndex === null) return;
    setLoading(true);
    setError(null);

    fetch(DECKS[selectedDeckIndex].url)
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch data');
        return res.text();
      })
      .then(text => {
        const rows = text.split('\n').map(line => {
          const parts = line.split('\t').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
          return { word: parts[0] || '', sentences: parts.slice(1) };
        }).filter((r: Row) => r.word);
        setData(rows);
        setSRS(loadSRS(DECKS[selectedDeckIndex].name));
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message ?? 'An error occurred');
        setLoading(false);
      });
  }, [selectedDeckIndex]);

  // ── TTS ─────────────────────────────────────────────────────────────────────

  const speak = useCallback((text: string, onEnd?: () => void) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.src = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
    audio.onended = () => onEnd?.();
    audio.onerror = () => onEnd?.();
    audio.play().catch(() => setIsPlaying(false));
  }, [lang]);

  // ── Promote current word then advance ────────────────────────────────────────

  const promoteAndAdvance = useCallback((idx: number, words: Row[]) => {
    // Promote only once per word in this session
    if (!promotedRef.current.has(idx)) {
      promotedRef.current.add(idx);
      const word = words[idx];
      const isNewWord = !srsRef.current[word.word];
      const newSRS = promoteWord(srsRef.current, word.word, isNewWord);
      setSRS(newSRS);
      saveSRS(DECKS[selectedDeckIndex!].name, newSRS);
    }

    const next = idx + 1;
    if (next >= words.length) {
      setIsSessionComplete(true);
      setIsPlaying(false);
    } else {
      setSessionIndex(next);
      setItemIndex(-1);
      // isPlaying stays true → player loop will fire for next word
    }
  }, [selectedDeckIndex]);

  // ── Player loop ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isPlaying || isSessionComplete) return;
    const currentWord = sessionWords[sessionIndex];
    if (!currentWord) return;

    const text = itemIndex === -1
      ? currentWord.word
      : currentWord.sentences[itemIndex];

    const isLastItem = itemIndex >= currentWord.sentences.length - 1;

    const advance = () => {
      if (isLastItem) {
        promoteAndAdvance(sessionIndex, sessionWords);
      } else {
        setItemIndex(prev => prev + 1);
      }
    };

    if (!text) {
      advance();
      return;
    }

    speak(text, () => {
      timerRef.current = setTimeout(advance, delay * 1000);
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const audio = audioRef.current;
      if (audio) { audio.pause(); audio.onended = null; }
    };
  // promoteAndAdvance and speak are stable enough; itemIndex/sessionIndex are the real triggers
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, itemIndex, sessionIndex, isSessionComplete]);

  // ── Navigation ──────────────────────────────────────────────────────────────

  function clearAudio() {
    if (timerRef.current) clearTimeout(timerRef.current);
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.onended = null; }
  }

  function skipForward() {
    clearAudio();
    const currentWord = sessionWords[sessionIndex];
    if (!currentWord) return;
    if (itemIndex >= currentWord.sentences.length - 1) {
      promoteAndAdvance(sessionIndex, sessionWords);
    } else {
      setItemIndex(prev => prev + 1);
    }
  }

  function skipBack() {
    clearAudio();
    if (itemIndex > -1) {
      setItemIndex(prev => prev - 1);
    } else if (sessionIndex > 0) {
      setSessionIndex(prev => prev - 1);
      setItemIndex(-1);
    }
  }

  function repeatCurrent() {
    const currentWord = sessionWords[sessionIndex];
    if (!currentWord) return;
    const text = itemIndex === -1 ? currentWord.word : currentWord.sentences[itemIndex];
    if (text) speak(text);
  }

  // ── Session lifecycle ───────────────────────────────────────────────────────

  function startSession(mode: SessionMode) {
    const words = mode === 'learn' ? getNewWords(data, srs) : getDueWords(data, srs);
    promotedRef.current = new Set();
    setSessionMode(mode);
    setSessionWords(words);
    setSessionIndex(0);
    setIsSessionComplete(false);
    setItemIndex(-1);
    setIsPlaying(true);
  }

  function endSession() {
    clearAudio();
    setIsPlaying(false);
    setSessionMode(null);
    setSessionWords([]);
    setSessionIndex(0);
    setIsSessionComplete(false);
    setItemIndex(-1);
    setShowSettings(false);
  }

  function changeDeck() {
    endSession();
    setSelectedDeckIndex(null);
    setData([]);
    setSRS({});
  }

  // ── Screens ──────────────────────────────────────────────────────────────────

  // Deck selection
  if (selectedDeckIndex === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 text-zinc-900 p-6">
        <div className="max-w-md w-full">
          <p className="text-zinc-500 text-center mb-8">Choose a deck to start learning</p>
          <div className="space-y-3">
            {DECKS.map((deck, index) => {
              const deckSRS = loadSRS(deck.name);
              const reviewCount = (Object.values(deckSRS) as WordSRS[]).filter(w => w.box >= 1 && w.nextReviewDate <= todayStr()).length;
              return (
                <button
                  key={index}
                  onClick={() => setSelectedDeckIndex(index)}
                  className="w-full p-6 bg-white rounded-2xl border-2 border-zinc-200 hover:border-zinc-900 hover:shadow-lg transition-all text-left"
                >
                  <h3 className="font-bold text-lg mb-2">{deck.name}</h3>
                  {reviewCount > 0 && (
                    <span className="text-xs font-medium px-2 py-1 bg-blue-50 text-blue-600 rounded-full">
                      {reviewCount} due for review
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50">
        <Loader2 className="w-12 h-12 animate-spin text-zinc-400 mb-4" />
        <p className="text-zinc-500">Loading vocabulary...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 p-6 text-center">
        <div className="bg-red-50 text-red-600 p-4 rounded-2xl mb-4 max-w-xs">
          <p className="font-bold mb-1">Error</p>
          <p className="text-sm">{error}</p>
        </div>
        <button onClick={() => window.location.reload()} className="px-6 py-2 bg-zinc-900 text-white rounded-full font-medium">
          Try Again
        </button>
      </div>
    );
  }

  // Session selection
  if (sessionMode === null) {
    const newWords = getNewWords(data, srs);
    const dueWords = getDueWords(data, srs);

    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 p-6">
        <div className="max-w-md w-full">
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 text-center mb-1">
            {DECKS[selectedDeckIndex].name}
          </p>
          <p className="text-zinc-500 text-center mb-8">What would you like to do?</p>

          <div className="space-y-3">
            <button
              onClick={() => startSession('learn')}
              disabled={newWords.length === 0}
              className="w-full p-6 bg-white rounded-2xl border-2 border-zinc-200 hover:border-emerald-400 hover:shadow-lg transition-all text-left disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <BookOpen className="w-5 h-5 text-emerald-500" />
                    <h3 className="font-bold text-lg">Learn</h3>
                  </div>
                  <p className="text-sm text-zinc-500">
                    {newWords.length > 0
                      ? `${newWords.length} new word${newWords.length !== 1 ? 's' : ''} today`
                      : "All new words learned for today"}
                  </p>
                </div>
                <span className="text-3xl font-bold text-emerald-500">{newWords.length}</span>
              </div>
            </button>

            <button
              onClick={() => startSession('review')}
              disabled={dueWords.length === 0}
              className="w-full p-6 bg-white rounded-2xl border-2 border-zinc-200 hover:border-blue-400 hover:shadow-lg transition-all text-left disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <RotateCcw className="w-5 h-5 text-blue-500" />
                    <h3 className="font-bold text-lg">Review</h3>
                  </div>
                  <p className="text-sm text-zinc-500">
                    {dueWords.length > 0
                      ? `${dueWords.length} word${dueWords.length !== 1 ? 's' : ''} due`
                      : 'No reviews due right now'}
                  </p>
                </div>
                <span className="text-3xl font-bold text-blue-500">{dueWords.length}</span>
              </div>
            </button>
          </div>

          {/* Box progress */}
          <div className="mt-8 p-4 bg-white rounded-2xl border border-zinc-100">
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-3">Your progress</p>
            <div className="space-y-1.5">
              {([1, 2, 3, 4, 5] as const).map(box => {
                const count = (Object.values(srs) as WordSRS[]).filter(w => w.box === box).length;
                const labels = ['', 'Every day', 'Every 3 days', 'Every week', 'Every 2 weeks', 'Once a month'];
                return (
                  <div key={box} className="flex items-center gap-3">
                    <span className="text-xs font-bold text-zinc-400 w-12">Box {box}</span>
                    <div className="flex-1 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-zinc-700 rounded-full"
                        style={{ width: count > 0 && data.length > 0 ? `${Math.min(100, (count / data.length) * 100)}%` : '0%' }}
                      />
                    </div>
                    <span className="text-xs text-zinc-400 w-8 text-right">{count}</span>
                    <span className="text-[10px] text-zinc-300 hidden sm:block w-28">{labels[box]}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <button onClick={changeDeck} className="mt-4 w-full text-center text-sm text-zinc-400 hover:text-zinc-600 py-2">
            ← Change deck
          </button>
        </div>
      </div>
    );
  }

  // Session complete
  if (isSessionComplete) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 p-6">
        <div className="max-w-md w-full text-center">
          <div className="text-6xl mb-6">🎉</div>
          <h2 className="text-2xl font-bold mb-2">Session complete!</h2>
          <p className="text-zinc-500 mb-8">
            {promotedRef.current.size} word{promotedRef.current.size !== 1 ? 's' : ''} {sessionMode === 'learn' ? 'learned' : 'reviewed'}
          </p>
          <button onClick={endSession} className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-medium">
            Back to menu
          </button>
        </div>
      </div>
    );
  }

  // ── Active session ────────────────────────────────────────────────────────────

  const currentWord = sessionWords[sessionIndex];
  const currentText = itemIndex === -1 ? currentWord?.word : currentWord?.sentences[itemIndex];
  const progress = sessionWords.length > 0 ? (promotedRef.current.size / sessionWords.length) * 100 : 0;
  const wordSRSData = srs[currentWord?.word];
  const boxLabel = wordSRSData ? `Box ${wordSRSData.box}` : 'New';

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 text-zinc-900 font-sans">
      <audio ref={audioRef} className="hidden" />

      {/* Header */}
      <header className="p-6 flex justify-between items-center">
        <div>
          <h1 className="text-xs font-bold uppercase tracking-widest text-zinc-400">
            {DECKS[selectedDeckIndex!].name}
          </h1>
          <p className="text-sm font-medium text-zinc-600">
            {sessionIndex + 1} / {sessionWords.length} · {sessionMode === 'learn' ? 'Learn' : 'Review'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-500 font-semibold">
            {boxLabel}
          </span>
          <button onClick={() => setShowSettings(s => !s)} className="p-2 rounded-full hover:bg-zinc-200 transition-colors">
            <Settings2 className="w-5 h-5 text-zinc-500" />
          </button>
        </div>
      </header>

      {/* Progress bar */}
      <div className="h-1 bg-zinc-100 mx-6 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-zinc-900 rounded-full"
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.4 }}
        />
      </div>

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${sessionIndex}-${itemIndex}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
            className="max-w-md w-full"
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400 mb-4">
              {itemIndex === -1 ? 'Word' : `Sentence ${itemIndex + 1}`}
            </p>
            <h2 className={`font-serif leading-tight mb-8 ${itemIndex === -1 ? 'text-5xl font-medium' : 'text-3xl italic text-zinc-700'}`}>
              {currentText}
            </h2>
            {itemIndex !== -1 && (
              <p className="text-sm text-zinc-400 font-mono">{currentWord.word}</p>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Settings panel */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-x-0 bottom-32 mx-6 p-6 bg-white rounded-3xl shadow-2xl border border-zinc-100 z-50"
          >
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-bold text-sm uppercase tracking-wider">Settings</h3>
              <button onClick={() => setShowSettings(false)} className="text-xs font-bold text-zinc-400 uppercase">Close</button>
            </div>
            <div className="space-y-6">
              <div>
                <label className="block text-[10px] font-bold uppercase text-zinc-400 mb-2">Wait between items</label>
                <div className="flex items-center gap-4">
                  <input
                    type="range" min="1" max="10" step="1" value={delay}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDelay(parseInt(e.target.value))}
                    className="flex-1 accent-zinc-900"
                  />
                  <span className="text-sm font-mono w-8">{delay}s</span>
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase text-zinc-400 mb-2">Language</label>
                <select
                  className="w-full p-3 bg-zinc-50 rounded-xl text-sm outline-none"
                  value={lang}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLang(e.target.value)}
                >
                  <option value="nl">Dutch (nl)</option>
                  <option value="en">English (en)</option>
                  <option value="fr">French (fr)</option>
                  <option value="de">German (de)</option>
                  <option value="es">Spanish (es)</option>
                  <option value="it">Italian (it)</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase text-zinc-400 mb-2">Session</label>
                <button onClick={endSession} className="w-full py-2.5 bg-zinc-100 hover:bg-zinc-200 rounded-xl text-sm font-medium transition-colors">
                  End session
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Controls */}
      <footer className="p-8 pb-12 flex flex-col items-center gap-8">
        <div className="flex items-center justify-center gap-6">
          <button onClick={skipBack} className="p-4 rounded-full text-zinc-400 hover:text-zinc-900 hover:bg-zinc-200 transition-all active:scale-95">
            <SkipBack className="w-6 h-6" />
          </button>

          <button
            onClick={() => setIsPlaying(p => !p)}
            className="w-20 h-20 flex items-center justify-center rounded-full bg-zinc-900 text-white shadow-xl shadow-zinc-200 hover:scale-105 active:scale-95 transition-all"
          >
            {isPlaying
              ? <Pause className="w-8 h-8 fill-current" />
              : <Play className="w-8 h-8 fill-current ml-1" />}
          </button>

          <button onClick={skipForward} className="p-4 rounded-full text-zinc-400 hover:text-zinc-900 hover:bg-zinc-200 transition-all active:scale-95">
            <SkipForward className="w-6 h-6" />
          </button>
        </div>

        <button
          onClick={repeatCurrent}
          className="flex items-center gap-2 px-6 py-3 rounded-full bg-white border border-zinc-200 text-sm font-medium hover:bg-zinc-50 active:scale-95 transition-all"
        >
          <Volume2 className="w-4 h-4" />
          Repeat
        </button>
      </footer>
    </div>
  );
}
