'use client';

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SkipForward, SkipBack, Volume2, Loader2, Brain, Settings } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import LingoRecall from './LingoRecall';
import { useDarkMode } from './DarkModeProvider';

// ── Types ────────────────────────────────────────────────────────────────────

interface Row {
  word: string;
  sentences: string[];
}

interface Deck {
  name: string;
  url: string;
  dailyLearnLimit?: number;
  dailyRecallLimit?: number;
}

interface WordSRS {
  box: number;            // 1–5
  nextReviewDate: string; // YYYY-MM-DD
  learnedDate: string;    // YYYY-MM-DD
}

interface DeckSRS {
  [word: string]: WordSRS;
}

type SessionMode = 'learn' | 'review' | 'recall';

// ── Constants ─────────────────────────────────────────────────────────────────

// Box index → review interval in days
// Box 1: every day · Box 2: every 3 days · Box 3: every week
// Box 4: every 2 weeks · Box 5: once a month
const BOX_INTERVALS = [0, 1, 3, 7, 14, 30];
const DEFAULT_DAILY_LEARN_LIMIT = 25;
const DEFAULT_DAILY_RECALL_LIMIT = 10;

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
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Support { key, data } wrapper format
    if (parsed && typeof parsed === 'object' && 'data' in parsed) return parsed.data;
    return parsed;
  } catch {
    return {};
  }
}

function saveSRS(deckName: string, srs: DeckSRS): void {
  localStorage.setItem(`srs_${deckName}`, JSON.stringify({ key: `srs_${deckName}`, data: srs }));
}

async function fetchRemoteSRS(deckName: string): Promise<DeckSRS> {
  try {
    const res = await fetch(`/api/srs?deck=${encodeURIComponent(deckName)}`);
    if (!res.ok) return {};
    const json = await res.json();
    // Unwrap { key, data } format
    if (json && typeof json === 'object' && 'data' in json) return json.data;
    return json;
  } catch { return {}; }
}

function saveRemoteSRS(deckName: string, srs: DeckSRS): void {
  fetch('/api/srs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deck: deckName, data: srs }),
  }).catch(() => {});
}

// Merge two SRS objects — for each word keep the entry with the higher box or newer learnedDate
function mergeSRS(local: DeckSRS, remote: DeckSRS): DeckSRS {
  const merged = { ...remote };
  for (const word of Object.keys(local)) {
    const l = local[word];
    const r = merged[word];
    if (!r || l.box > r.box || (l.box === r.box && l.nextReviewDate > r.nextReviewDate)) {
      merged[word] = l;
    }
  }
  return merged;
}

function getNewWords(data: Row[], srs: DeckSRS, dailyLimit = DEFAULT_DAILY_LEARN_LIMIT): Row[] {
  const today = todayStr();
  const learnedToday = (Object.values(srs) as WordSRS[]).filter(w => w.learnedDate === today).length;
  const remaining = Math.max(0, dailyLimit - learnedToday);
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
  // Dark mode
  const { isDark, toggle: toggleDarkMode } = useDarkMode();

  // Hydration guard – defer localStorage reads until client mount
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => { setHasMounted(true); }, []);

  // Decks (stored on backend S3)
  const [decks, setDecks] = useState<Deck[]>([]);
  const [decksLoading, setDecksLoading] = useState(true);
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckUrl, setNewDeckUrl] = useState('');

  useEffect(() => {
    if (!hasMounted) return;
    fetch('/api/decks').then(r => r.json()).then(d => { if (Array.isArray(d)) setDecks(d); }).finally(() => setDecksLoading(false));
  }, [hasMounted]);

  async function addDeck() {
    const name = newDeckName.trim();
    const url = newDeckUrl.trim();
    if (!name || !url) return;
    const res = await fetch('/api/decks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url }) });
    const updated = await res.json();
    if (Array.isArray(updated)) setDecks(updated);
    setNewDeckName('');
    setNewDeckUrl('');
  }

  async function removeDeck(index: number) {
    const res = await fetch('/api/decks', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }) });
    const updated = await res.json();
    if (Array.isArray(updated)) setDecks(updated);
  }

  // Deck & data
  const [selectedDeckIndex, setSelectedDeckIndex] = useState<number | null>(null);
  const [data, setData] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [srs, setSRS] = useState<DeckSRS>({});
  const [recallRemaining, setRecallRemaining] = useState<number | null>(null);
  const [recallTotal, setRecallTotal] = useState<number | null>(null);

  // Deck settings panel
  const [showDeckSettings, setShowDeckSettings] = useState(false);
  const [editLearnLimit, setEditLearnLimit] = useState('');
  const [editRecallLimit, setEditRecallLimit] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

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

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Translation
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  // Keep a ref to current srs so the async player loop always reads fresh state
  const srsRef = useRef<DeckSRS>(srs);
  srsRef.current = srs;

  // SRS remote sync — debounce saves to S3 (30s after last change)
  const syncTimerRef = useRef<NodeJS.Timeout | null>(null);
  const srsDirtyRef = useRef(false);

  function markSRSDirty() {
    srsDirtyRef.current = true;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(flushSRS, 30_000);
  }

  function flushSRS() {
    if (!srsDirtyRef.current || selectedDeckIndex === null) return;
    srsDirtyRef.current = false;
    if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null; }
    saveRemoteSRS(decks[selectedDeckIndex].name, srsRef.current);
  }

  // Flush on page unload
  useEffect(() => {
    const handleUnload = () => flushSRS();
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  });

  // ── Fetch data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (selectedDeckIndex === null) return;
    setLoading(true);
    setError(null);

    const deckName = decks[selectedDeckIndex].name;

    Promise.all([
      fetch(decks[selectedDeckIndex].url).then(res => {
        if (!res.ok) throw new Error('Failed to fetch data');
        return res.text();
      }),
      fetchRemoteSRS(deckName),
    ])
      .then(([text, remoteSRS]) => {
        const rows = text.split('\n').map(line => {
          const parts = line.split('\t').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
          return { word: parts[0] || '', sentences: parts.slice(1) };
        }).filter((r: Row) => r.word);
        setData(rows);

        const localSRS = loadSRS(deckName);
        const merged = mergeSRS(localSRS, remoteSRS);
        setSRS(merged);
        saveSRS(deckName, merged);
        // If remote was stale, push merged version back
        if (Object.keys(localSRS).length > Object.keys(remoteSRS).length) {
          saveRemoteSRS(deckName, merged);
        }
        
        // Fetch recall state to calculate remaining
        fetch(`/api/recall?deck=${encodeURIComponent(deckName)}`)
          .then(r => r.json())
          .then(recallState => {
            const today = new Date().toISOString().split('T')[0];
            const todayAsked = (recallState.sessionHistory || [])
              .filter((s: { date: string }) => s.date === today)
              .reduce((acc: number, s: { sentencesAsked?: number; masteredSentences: string[] }) => acc + (s.sentencesAsked ?? (s.masteredSentences || []).length), 0);
            const recallLimit = decks[selectedDeckIndex!]?.dailyRecallLimit ?? DEFAULT_DAILY_RECALL_LIMIT;
            const dailyLimit = Math.max(0, recallLimit - todayAsked);
            const completedSet = new Set(recallState.completedSentences || []);
            let availableSentences = 0;
            for (const row of rows) {
              const wordSRS = merged[row.word];
              if (wordSRS && wordSRS.box >= 1) {
                for (let i = 0; i < row.sentences.length; i++) {
                  const id = `${row.word}::${i}`;
                  if (!completedSet.has(id)) availableSentences++;
                }
              }
            }
            setRecallTotal(availableSentences);
            setRecallRemaining(Math.min(dailyLimit, availableSentences));
          })
          .catch(() => setRecallRemaining(null));
        
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message ?? 'An error occurred');
        setLoading(false);
      });
  }, [selectedDeckIndex, decks]);

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
      saveSRS(decks[selectedDeckIndex!].name, newSRS);
      markSRSDirty();
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

  async function translateCurrent() {
    const currentWord = sessionWords[sessionIndex];
    if (!currentWord) return;
    const text = itemIndex === -1 ? currentWord.word : currentWord.sentences[itemIndex];
    if (!text) return;

    // Stop playback
    clearAudio();
    setIsPlaying(false);
    setTranslation(null);
    setTranslating(true);

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, to: 'en' }),
      });
      const data = await res.json();
      setTranslation(data.translation || 'Translation failed');
    } catch {
      setTranslation('Translation failed');
    } finally {
      setTranslating(false);
    }
  }

  // Clear translation when moving to next item
  useEffect(() => {
    setTranslation(null);
  }, [sessionIndex, itemIndex]);

  // ── Session lifecycle ───────────────────────────────────────────────────────

  function startSession(mode: SessionMode) {
    const learnLimit = selectedDeckIndex !== null ? (decks[selectedDeckIndex].dailyLearnLimit ?? DEFAULT_DAILY_LEARN_LIMIT) : DEFAULT_DAILY_LEARN_LIMIT;
    const words = mode === 'learn' ? getNewWords(data, srs, learnLimit) : getDueWords(data, srs);
    promotedRef.current = new Set();
    setSessionMode(mode);
    setSessionWords(words);
    setSessionIndex(0);
    setIsSessionComplete(false);
    setItemIndex(-1);
    setIsPlaying(true);
  }

  function refreshRecallRemaining() {
    if (selectedDeckIndex === null) return;
    const deckName = decks[selectedDeckIndex].name;
    
    fetch(`/api/recall?deck=${encodeURIComponent(deckName)}`)
      .then(r => r.json())
      .then(recallState => {
        const today = new Date().toISOString().split('T')[0];
        const todayAsked = (recallState.sessionHistory || [])
          .filter((s: { date: string }) => s.date === today)
          .reduce((acc: number, s: { sentencesAsked?: number; masteredSentences: string[] }) => acc + (s.sentencesAsked ?? (s.masteredSentences || []).length), 0);
        const recallLimit = decks[selectedDeckIndex!]?.dailyRecallLimit ?? DEFAULT_DAILY_RECALL_LIMIT;
        const dailyLimit = Math.max(0, recallLimit - todayAsked);
        const completedSet = new Set(recallState.completedSentences || []);
        let availableSentences = 0;
        for (const row of data) {
          const wordSRS = srs[row.word];
          if (wordSRS && wordSRS.box >= 1) {
            for (let i = 0; i < row.sentences.length; i++) {
              const id = `${row.word}::${i}`;
              if (!completedSet.has(id)) availableSentences++;
            }
          }
        }
        setRecallTotal(availableSentences);
        setRecallRemaining(Math.min(dailyLimit, availableSentences));
      })
      .catch(() => {});
  }

  function endSession() {
    clearAudio();
    flushSRS();
    setIsPlaying(false);
    setSessionMode(null);
    setSessionWords([]);
    setSessionIndex(0);
    setIsSessionComplete(false);
    setItemIndex(-1);
    // Refresh recall count after returning from recall session
    refreshRecallRemaining();
  }

  function changeDeck() {
    flushSRS();
    endSession();
    setSelectedDeckIndex(null);
    setData([]);
    setSRS({});
    setRecallRemaining(null);
  }

  // ── Screens ──────────────────────────────────────────────────────────────────

  // Deck selection
  if (selectedDeckIndex === null) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <p className="font-serif text-4xl font-normal text-center mb-2">LingoPlayer</p>
          <p className="text-[var(--text-muted)] text-center text-base mb-10">Select a deck</p>

          {decksLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
          ) : (
            <>
              <div className="space-y-2 mb-8">
                {decks.map((deck, index) => {
                  return (
                    <div key={index} className="relative group flex items-center">
                      <button
                        onClick={() => setSelectedDeckIndex(index)}
                        className="flex-1 text-left py-3 border-b border-[var(--border-color)] hover:border-[var(--text-primary)] transition-colors"
                      >
                        <span className="font-medium text-lg">{deck.name}</span>
                      </button>
                      <button
                        onClick={() => { if (confirm(`Delete "${deck.name}"?`)) removeDeck(index); }}
                        className="opacity-0 group-hover:opacity-100 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all px-2"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                {decks.length === 0 && (
                  <p className="text-sm text-[var(--text-muted)] text-center py-4">No decks yet.</p>
                )}
              </div>

              <div className="space-y-2 border-t border-[var(--border-color)] pt-6">
                <input
                  type="text"
                  placeholder="Deck name"
                  value={newDeckName}
                  onChange={e => setNewDeckName(e.target.value)}
                  className="w-full py-2 bg-transparent border-b border-[var(--border-color)] focus:border-[var(--text-primary)] outline-none text-sm transition-colors placeholder:text-[var(--text-muted)]"
                />
                <input
                  type="url"
                  placeholder="TSV URL"
                  value={newDeckUrl}
                  onChange={e => setNewDeckUrl(e.target.value)}
                  className="w-full py-2 bg-transparent border-b border-[var(--border-color)] focus:border-[var(--text-primary)] outline-none text-sm transition-colors placeholder:text-[var(--text-muted)]"
                />
                <button
                  onClick={addDeck}
                  disabled={!newDeckName.trim() || !newDeckUrl.trim()}
                  className="w-full mt-2 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors text-center"
                >
                  + Add deck
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[var(--bg-primary)] p-8 text-center">
        <p className="text-sm text-[var(--text-muted)] mb-4">{error}</p>
        <button onClick={() => window.location.reload()} className="text-sm underline text-[var(--text-primary)]">
          Retry
        </button>
      </div>
    );
  }

  // Session selection
  if (sessionMode === null) {
    const deck = decks[selectedDeckIndex];
    const learnLimit = deck.dailyLearnLimit ?? DEFAULT_DAILY_LEARN_LIMIT;
    const recallLimit = deck.dailyRecallLimit ?? DEFAULT_DAILY_RECALL_LIMIT;
    const newWords = getNewWords(data, srs, learnLimit);
    const dueWords = getDueWords(data, srs);

    return (
      <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <p className="font-serif text-3xl font-normal text-center mb-2">{decks[selectedDeckIndex].name}</p>
          <div className="flex items-center justify-center gap-2 mb-4">
            <p className="text-[var(--text-muted)] text-center text-base mb-2">{data.length} words</p>
            <p className="text-[var(--text-muted)] text-center text-base mb-2">|</p>
            <p className="text-[var(--text-muted)] text-center text-base mb-2">{data.reduce((acc, row) => acc + row.sentences.length, 0)} sentences</p>
          </div>

          <div className="space-y-px">
            {[
              { mode: 'learn' as SessionMode, label: 'Learn', count: newWords.length, note: 'new' },
              { mode: 'review' as SessionMode, label: 'Review', count: dueWords.length, note: 'due' },
              { mode: 'recall' as SessionMode, label: 'Recall', count: recallRemaining ?? 0, note: 'due', disabled: (Object.values(srs) as WordSRS[]).filter(w => w.box >= 1).length === 0 || (recallRemaining ?? 0) === 0 },
            ].map(({ mode, label, count, note, disabled }) => (
              <button
                key={mode}
                onClick={() => mode === 'recall' ? setSessionMode('recall') : startSession(mode)}
                disabled={disabled ?? count === 0}
                className="w-full flex items-center justify-between py-3 border-b border-[var(--border-color)] hover:border-[var(--text-primary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-left"
              >
                <span className="font-medium text-lg">{label}</span>
                <span className="text-base text-[var(--text-muted)]">{count} {note}</span>
              </button>
            ))}
          </div>

          <div className="mt-10 space-y-1">
            {([1, 2, 3, 4, 5] as const).map(box => {
              const count = (Object.values(srs) as WordSRS[]).filter(w => w.box === box).length;
              return (
                <div key={box} className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                  <span className="w-10">Box {box}</span>
                  <div className="flex-1 h-px bg-[var(--border-color)]">
                    <div className="h-px bg-[var(--text-primary)]" style={{ width: count > 0 && data.length > 0 ? `${Math.min(100, (count / data.length) * 100)}%` : '0%' }} />
                  </div>
                  <span className="w-6 text-right">{count}</span>
                </div>
              );
            })}
          </div>

          <div className="mt-8 flex items-center justify-between">
            <button onClick={changeDeck} className="text-base text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
              ← Decks
            </button>
            <button
              onClick={() => { setEditLearnLimit(String(learnLimit)); setEditRecallLimit(String(recallLimit)); setShowDeckSettings(true); }}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Settings modal */}
        <AnimatePresence>
          {showDeckSettings && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 bg-[var(--bg-primary)] flex items-center justify-center p-8 z-50"
              onClick={e => { if (e.target === e.currentTarget) setShowDeckSettings(false); }}
            >
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.15 }}
                className="w-full max-w-sm"
              >
                <div className="flex items-center justify-between mb-8">
                  <p className="font-serif text-2xl font-normal">Daily limits</p>
                  <button onClick={() => setShowDeckSettings(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-xl leading-none">×</button>
                </div>

                <div className="space-y-6">
                  <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-4">
                    <div>
                      <p className="font-medium">Learn</p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">New words per day</p>
                    </div>
                    <input
                      type="number" min="1" max="500"
                      value={editLearnLimit}
                      onChange={e => setEditLearnLimit(e.target.value)}
                      className="w-16 bg-transparent border-b border-[var(--border-color)] focus:border-[var(--text-primary)] outline-none text-right text-lg"
                    />
                  </div>

                  <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-4">
                    <div>
                      <p className="font-medium">Recall</p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">Sentences per day</p>
                    </div>
                    <input
                      type="number" min="1" max="500"
                      value={editRecallLimit}
                      onChange={e => setEditRecallLimit(e.target.value)}
                      className="w-16 bg-transparent border-b border-[var(--border-color)] focus:border-[var(--text-primary)] outline-none text-right text-lg"
                    />
                  </div>
                </div>

                <button
                  disabled={savingSettings}
                  onClick={async () => {
                    const newLearn = Math.max(1, parseInt(editLearnLimit) || learnLimit);
                    const newRecall = Math.max(1, parseInt(editRecallLimit) || recallLimit);
                    setSavingSettings(true);
                    try {
                      const res = await fetch('/api/decks', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ index: selectedDeckIndex, dailyLearnLimit: newLearn, dailyRecallLimit: newRecall }),
                      });
                      const updated = await res.json();
                      if (Array.isArray(updated)) setDecks(updated);
                      setShowDeckSettings(false);
                    } finally {
                      setSavingSettings(false);
                    }
                  }}
                  className="mt-8 w-full py-3 text-base font-medium border border-[var(--border-color)] hover:border-[var(--text-primary)] transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {savingSettings && <Loader2 className="w-4 h-4 animate-spin" />}
                  Save
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // Lingo Recall session
  if (sessionMode === 'recall') {
    return (
      <LingoRecall
        deckName={decks[selectedDeckIndex].name}
        data={data}
        srs={srs}
        dailyRecallLimit={decks[selectedDeckIndex].dailyRecallLimit ?? DEFAULT_DAILY_RECALL_LIMIT}
        onBack={endSession}
      />
    );
  }

  // Session complete
  if (isSessionComplete) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] p-8">
        <div className="max-w-sm w-full text-center">
          <p className="font-serif text-3xl font-normal mb-2">Done</p>
          <p className="text-[var(--text-muted)] text-sm mb-10">
            {promotedRef.current.size} word{promotedRef.current.size !== 1 ? 's' : ''} {sessionMode === 'learn' ? 'learned' : 'reviewed'}
          </p>
          <button onClick={endSession} className="text-sm underline text-[var(--text-primary)]">
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
    <div className="flex flex-col min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <audio ref={audioRef} className="hidden" />

      {/* Progress bar */}
      <div className="h-px bg-[var(--border-color)]">
        <motion.div
          className="h-px bg-[var(--text-primary)]"
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.4 }}
        />
      </div>

      {/* Header */}
      <header className="px-8 py-4 flex justify-between items-center text-sm text-[var(--text-muted)]">
        <span className="text-base">{sessionIndex + 1} / {sessionWords.length}</span>
        <div className="flex items-center gap-4">
          <span className="text-base">{boxLabel}</span>
          <button onClick={endSession} className="text-base hover:text-[var(--text-primary)] transition-colors">End</button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${sessionIndex}-${itemIndex}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="max-w-md w-full"
          >
            <p className="text-sm text-[var(--text-muted)] mb-6 tracking-widest uppercase">
              {itemIndex === -1 ? 'word' : `sentence ${itemIndex + 1}`}
            </p>
            <h2 className={`font-serif leading-snug ${itemIndex === -1 ? 'text-6xl font-normal' : 'text-3xl italic text-[var(--text-secondary)]'}`}>
              {currentText}
            </h2>
            {itemIndex !== -1 && (
              <p className="mt-4 text-base text-[var(--text-muted)] font-mono">{currentWord.word}</p>
            )}
            {translation && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-6 text-base text-[var(--text-secondary)] italic"
              >
                {translation}
              </motion.p>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Settings row */}
      <div className="px-8 py-2 flex justify-center gap-6 text-sm text-[var(--text-muted)]">
        <label className="flex items-center gap-2">
          <span>Delay</span>
          <input
            type="range" min="1" max="10" step="1" value={delay}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDelay(parseInt(e.target.value))}
            className="w-20 accent-[var(--text-primary)]"
          />
          <span>{delay}s</span>
        </label>
        <select
          className="bg-transparent outline-none text-xs text-[var(--text-muted)]"
          value={lang}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLang(e.target.value)}
        >
          <option value="nl">nl</option>
          <option value="en">en</option>
          <option value="fr">fr</option>
          <option value="de">de</option>
          <option value="es">es</option>
          <option value="it">it</option>
        </select>
      </div>

      {/* Controls */}
      <footer className="px-8 py-8 flex flex-col items-center gap-6">
        <div className="flex items-center gap-8">
          <button onClick={skipBack} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors active:scale-95">
            <SkipBack className="w-5 h-5" />
          </button>

          <button
            onClick={() => setIsPlaying(p => !p)}
            className="w-16 h-16 flex items-center justify-center rounded-full border border-[var(--border-color)] hover:border-[var(--text-primary)] text-[var(--text-primary)] transition-colors active:scale-95"
          >
            {isPlaying
              ? <Pause className="w-6 h-6 fill-current" />
              : <Play className="w-6 h-6 fill-current ml-0.5" />}
          </button>

          <button onClick={skipForward} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors active:scale-95">
            <SkipForward className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-6 text-sm text-[var(--text-muted)]">
          <button onClick={repeatCurrent} className="flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors">
            <Volume2 className="w-3.5 h-3.5" />
            Repeat
          </button>
          <button
            onClick={translateCurrent}
            disabled={translating}
            className="flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
          >
            {translating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Translate
          </button>
        </div>
      </footer>
    </div>
  );
}
