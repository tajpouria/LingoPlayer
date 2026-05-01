'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Loader2, Volume2, Languages, Wand2, Copy, Check, AlertCircle, Moon, Sun } from 'lucide-react';
import { useDarkMode } from './DarkModeProvider';
import { AnimatePresence, motion } from 'motion/react';

interface Row {
  word: string;
  sentences: string[];
}

// Internal row with a stable identity so React never re-uses the wrong DOM node
// after insert/delete. _id is stripped before sending to the server.
interface SRow extends Row {
  _id: string;
}

interface DeckSheetProps {
  deckName: string;
  lang: string;
  onBack: (updatedRows: Row[]) => void;
}

const HEADERS = ['Word', 'Example 1', 'Example 2', 'Example 3'];
const COLS = 4;

let _idSeq = 0;
function mkRow(word = '', sentences = ['', '', '']): SRow {
  return { _id: `r${_idSeq++}`, word, sentences: [...sentences] };
}

function withTrailing(rows: SRow[]): SRow[] {
  const last = rows[rows.length - 1];
  const hasTrailing = last && !last.word.trim() && last.sentences.every(s => !s.trim());
  return hasTrailing ? rows : [...rows, mkRow()];
}

// Must stay in sync with cell_hash() in generate_audio.py.
function cellHash(language: string, text: string): string {
  const bytes = new TextEncoder().encode(`${language}:${text}`);
  let h = 2166136261;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

function cleanRows(r: Row[]): Row[] {
  return r
    .filter(row => row.word.trim())
    .map(row => ({ word: row.word.trim(), sentences: row.sentences.filter(s => s.trim()) }));
}

export default function DeckSheet({ deckName, lang, onBack }: DeckSheetProps) {
  const { isDark, toggle: toggleDarkMode } = useDarkMode();

  const localKey = `lp_sheet_${deckName}`;

  // rows tracks STRUCTURE only (which rows exist, their IDs, and initial content).
  // Typed content lives in the textarea DOM nodes — React never touches them while typing.
  const [rows, setRows] = useState<SRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'synced' | 'pending' | 'offline' | 'error'>('synced');
  const [showSaved, setShowSaved] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [wordCount, setWordCount] = useState(0);
  // ri -> ri of the first occurrence of the same word
  const [duplicateErrors, setDuplicateErrors] = useState<Map<number, number>>(new Map());

  // Cell hover popup
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);
  const [hoveredCellText, setHoveredCellText] = useState<string>('');
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({});
  const [translatingText, setTranslatingText] = useState<string | null>(null);
  const hoverSessionRef = useRef(0);

  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 640
  );
  const [focusedCell, setFocusedCell] = useState<string | null>(null);
  const blurTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Generate-examples modal
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [computedPrompt, setComputedPrompt] = useState<string | null>(null);
  const [hasMissingExamples, setHasMissingExamples] = useState(false);
  const [generatePaste, setGeneratePaste] = useState('');
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [applySuccess, setApplySuccess] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const isDirtyRef = useRef(false);
  const suppressSaveRef = useRef(false);
  const isFirstEffect = useRef(true);
  const syncTimerRef = useRef<NodeJS.Timeout | null>(null);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Rows as last received from server — used to detect rows added by other devices
  const serverBaseRef = useRef<Row[]>([]);

  const cellRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Read live content from DOM ────────────────────────────────────────────────
  // This is the single source of truth for saves — not `rows` state.

  function readRows(): SRow[] {
    return rowsRef.current.map((row, ri) => ({
      ...row,
      word: cellRefs.current.get(`${ri}:0`)?.value ?? row.word,
      sentences: [1, 2, 3].map(ci =>
        cellRefs.current.get(`${ri}:${ci}`)?.value ?? row.sentences[ci - 1] ?? ''
      ),
    }));
  }

  // ── S3 sync ───────────────────────────────────────────────────────────────────

  const syncToServer = useCallback(async (r: Row[]) => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    if (!navigator.onLine) { setSyncStatus('offline'); return; }
    try {
      let rowsToSave = cleanRows(r);

      // Before writing, fetch the current server state and append any rows that were
      // added by another device since we last loaded — prevents a stale tab from
      // silently deleting rows that a newer session already saved.
      try {
        const res = await fetch(`/api/deck-data?deck=${encodeURIComponent(deckName)}`);
        if (res.ok) {
          const serverRows: Row[] = await res.json();
          if (Array.isArray(serverRows) && serverRows.length > 0) {
            const baseWords = new Set(serverBaseRef.current.map(row => row.word.trim().toLowerCase()));
            const clientWords = new Set(rowsToSave.map(row => row.word.trim().toLowerCase()));
            const addedElsewhere = serverRows.filter(row =>
              row.word.trim() &&
              !baseWords.has(row.word.trim().toLowerCase()) &&
              !clientWords.has(row.word.trim().toLowerCase())
            );
            if (addedElsewhere.length > 0) {
              rowsToSave = [...rowsToSave, ...cleanRows(addedElsewhere)];
            }
          }
        }
      } catch { /* pre-fetch failed — proceed with local rows only */ }

      await fetch('/api/deck-data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deck: deckName, rows: rowsToSave }),
      });
      serverBaseRef.current = rowsToSave;
      isDirtyRef.current = false;
      setSyncStatus('synced');
    } catch {
      setSyncStatus('error');
      retryTimerRef.current = setTimeout(() => syncToServer(readRows()), 5000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckName]);

  // Brief "Saved" flash
  useEffect(() => {
    if (syncStatus !== 'synced') return;
    setShowSaved(true);
    const t = setTimeout(() => setShowSaved(false), 2000);
    return () => clearTimeout(t);
  }, [syncStatus]);

  // ── Debounced save (called from onChange and structural changes) ───────────────
  // Does NOT call setRows — reads directly from the DOM.

  function scheduleSave(immediate?: SRow[]) {
    const current = immediate ?? readRows();
    // Immediate localStorage write
    try { localStorage.setItem(localKey, JSON.stringify(current)); } catch { /* quota */ }
    isDirtyRef.current = true;
    setSyncStatus('pending');
    // Update word count and missing-examples flag cheaply
    const cleaned = cleanRows(current);
    setWordCount(cleaned.length);
    setHasMissingExamples(cleaned.some(r => r.sentences.length < 3));
    // Debounced S3 write
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => syncToServer(readRows()), 1500);
  }

  // ── Data load ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    // Instant display from localStorage
    try {
      const raw = localStorage.getItem(localKey);
      if (raw) {
        const cached: Row[] = JSON.parse(raw);
        if (Array.isArray(cached) && cached.length > 0) {
          const srows = withTrailing(cached.map(r => mkRow(r.word, r.sentences)));
          suppressSaveRef.current = true;
          setRows(srows);
          const cleaned = cleanRows(srows);
          setWordCount(cleaned.length);
          setHasMissingExamples(cleaned.some(r => r.sentences.length < 3));
        }
      }
    } catch { /* corrupt cache */ }

    // Background server fetch
    fetch(`/api/deck-data?deck=${encodeURIComponent(deckName)}`)
      .then(r => r.json())
      .then((data: Row[]) => {
        if (cancelled) return;
        const serverRows = Array.isArray(data) && data.length > 0
          ? withTrailing(data.map(r => mkRow(r.word, r.sentences)))
          : null;
        if (serverRows && !isDirtyRef.current) {
          suppressSaveRef.current = true;
          setRows(serverRows);
          const cleaned = cleanRows(serverRows);
          setWordCount(cleaned.length);
          setHasMissingExamples(cleaned.some(r => r.sentences.length < 3));
          serverBaseRef.current = cleaned;
          try { localStorage.setItem(localKey, JSON.stringify(serverRows)); } catch { /* quota */ }
          // Push server content into already-mounted textareas
          requestAnimationFrame(() => {
            serverRows.forEach((row, ri) => {
              const set = (ci: number, v: string) => {
                const el = cellRefs.current.get(`${ri}:${ci}`);
                if (el) { el.value = v; autoResize(el); }
              };
              set(0, row.word);
              row.sentences.forEach((s, i) => set(i + 1, s));
            });
          });
        } else if (!serverRows && !localStorage.getItem(localKey)) {
          const empty = [mkRow()];
          setRows(empty);
          setWordCount(0);
          setHasMissingExamples(false);
        }
      })
      .catch(() => { /* keep local */ })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckName]);

  // ── Skip the very first rows-change triggered by load ────────────────────────
  // (we don't want to mark dirty on the initial data arrival)

  useEffect(() => {
    if (isFirstEffect.current) { isFirstEffect.current = false; return; }
    if (suppressSaveRef.current) { suppressSaveRef.current = false; return; }
    // Read from DOM so uncontrolled textarea content is captured correctly
    scheduleSave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // ── Online / offline ──────────────────────────────────────────────────────────

  useEffect(() => {
    const onOnline  = () => { if (isDirtyRef.current) syncToServer(readRows()); else setSyncStatus('synced'); };
    const onOffline = () => setSyncStatus('offline');
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncToServer]);

  // ── Flush on unmount ──────────────────────────────────────────────────────────

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current)  clearTimeout(syncTimerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (blurTimerRef.current)  clearTimeout(blurTimerRef.current);
      if (isDirtyRef.current) {
        // State updates inside syncToServer will silently no-op after unmount — that's fine
        syncToServer(readRows());
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckName, syncToServer]);

  // ── TTS ──────────────────────────────────────────────────────────────────────

  const speak = useCallback((text: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    const fallbackSrc = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
    const hash = cellHash(lang, text);
    fetch('/api/audio-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: { url?: string } | null) => { audio.src = data?.url ?? fallbackSrc; audio.play().catch(() => {}); })
      .catch(() => { audio.src = fallbackSrc; audio.play().catch(() => {}); });
  }, [lang]);

  // ── Translate ─────────────────────────────────────────────────────────────────

  async function translateCell(text: string) {
    if (!text.trim() || translatingText === text) return;
    const mySession = hoverSessionRef.current;
    setTranslatingText(text);
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, to: 'en' }),
      });
      const data = await res.json() as { translation?: string };
      if (hoverSessionRef.current === mySession) {
        setTranslationCache(prev => ({ ...prev, [text]: data.translation ?? 'Translation failed' }));
      }
    } catch {
      if (hoverSessionRef.current === mySession) {
        setTranslationCache(prev => ({ ...prev, [text]: 'Translation failed' }));
      }
    } finally {
      if (hoverSessionRef.current === mySession) {
        setTranslatingText(null);
      }
    }
  }

  // ── Generate-examples prompt ──────────────────────────────────────────────────

  function buildPrompt(current: Row[]): string | null {
    const cleaned = cleanRows(current);
    const missingRows = cleaned.filter(r => r.sentences.length < 3);
    if (missingRows.length === 0) return null;
    const contextRows = cleaned.filter(r => r.sentences.length === 3).slice(-100);
    const contextBlock = contextRows.length > 0
      ? contextRows.map(r => [r.word, ...r.sentences].join(',')).join('\n')
      : '(no complete rows yet)';
    const missingBlock = missingRows.map(r => [r.word, ...r.sentences].join(',')).join('\n');
    return `Generate two more examples for each word that is missing examples on the same level to help learning the word, try to reuse the words from the list and introduce new words if needed, keep it on a same level as other words and sentences, use the most common examples that are used on a daily basis. Each must have three examples in total, keeping the examples I already provided in a spreadsheet format, only give for the rows that are missing. No headers for the output only values. Try to not introduce new or too complex words. Give me the answer here and in json.

Here is my vocabulary list for context (${contextRows.length} words — use these to calibrate the difficulty and reuse vocabulary where natural):

${contextBlock}

Words missing examples — generate so each reaches exactly 3 total, keeping what I already have verbatim:

${missingBlock}

Reply with a JSON array only (no other prose), like this:
\`\`\`json
[{"word":"<word>","examples":["sentence 1","sentence 2","sentence 3"]},...]
\`\`\`
Only include the words listed in the "missing" section above. Keep my existing examples exactly as written. Only generate the ones needed to bring each word to 3 examples.`;
  }

  function openGenerateModal() {
    const prompt = buildPrompt(readRows());
    setComputedPrompt(prompt);
    setShowGenerateModal(true);
  }

  // Not a useMemo — only computed when modal opens (avoids per-keystroke work)
  const generatePrompt = showGenerateModal ? computedPrompt : null;

  async function copyPrompt() {
    if (!generatePrompt) return;
    try {
      await navigator.clipboard.writeText(generatePrompt);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2000);
    } catch { /* ignore */ }
  }

  async function applyGenerated() {
    setGenerateError(null);
    setApplyLoading(true);
    await new Promise(r => setTimeout(r, 0));
    try {
      let jsonStr = generatePaste.trim();
      const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) jsonStr = match[1].trim();
      const result = JSON.parse(jsonStr) as Array<{ word: string; examples: string[] }>;
      if (!Array.isArray(result)) throw new Error('Expected a JSON array.');

      let appliedCount = 0;
      const newRows = rowsRef.current.map((row, ri) => {
        const domWord = cellRefs.current.get(`${ri}:0`)?.value ?? row.word;
        const entry = result.find(r =>
          typeof r.word === 'string' && r.word.trim().toLowerCase() === domWord.trim().toLowerCase()
        );
        if (!entry || !Array.isArray(entry.examples)) return row;
        const sentences = entry.examples.slice(0, 3).map(String);
        while (sentences.length < 3) sentences.push('');
        appliedCount++;
        return { ...row, word: domWord, sentences };
      });

      if (appliedCount === 0)
        throw new Error('No matching words found. Make sure the words in the JSON match your sheet exactly.');

      // Update React structure
      suppressSaveRef.current = true;
      setRows(newRows);

      // Push new sentence values directly into DOM (uncontrolled textareas won't update from defaultValue)
      requestAnimationFrame(() => {
        newRows.forEach((row, ri) => {
          const set = (ci: number, v: string) => {
            const el = cellRefs.current.get(`${ri}:${ci}`);
            if (el) { el.value = v; autoResize(el); }
          };
          set(0, row.word);
          row.sentences.forEach((s, i) => set(i + 1, s));
        });
        scheduleSave(newRows);
      });

      setApplySuccess(true);
      setTimeout(() => {
        setShowGenerateModal(false);
        setApplySuccess(false);
        setGeneratePaste('');
        setGenerateError(null);
      }, 1500);
    } catch (e) {
      setGenerateError((e as Error).message);
    } finally {
      setApplyLoading(false);
    }
  }

  // ── Cell helpers ──────────────────────────────────────────────────────────────

  function checkDuplicates() {
    const wordMap = new Map<string, number>();
    const errors = new Map<number, number>();
    rowsRef.current.forEach((row, ri) => {
      const word = (cellRefs.current.get(`${ri}:0`)?.value ?? row.word).trim().toLowerCase();
      if (!word) return;
      if (wordMap.has(word)) {
        errors.set(ri, wordMap.get(word)!);
      } else {
        wordMap.set(word, ri);
      }
    });
    setDuplicateErrors(errors);
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  // Resize all cells, scroll to bottom, then reveal the sheet
  useEffect(() => {
    if (!loading) {
      requestAnimationFrame(() => {
        cellRefs.current.forEach(el => autoResize(el));
        // Second frame: scroll after heights are settled, then reveal
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
          setIsReady(true);
        });
      });
    }
  }, [loading]);

  function setRef(ri: number, ci: number) {
    return (el: HTMLTextAreaElement | null) => {
      const key = `${ri}:${ci}`;
      if (el) cellRefs.current.set(key, el);
      else cellRefs.current.delete(key);
    };
  }

  function focusCell(ri: number, ci: number) {
    setTimeout(() => cellRefs.current.get(`${ri}:${ci}`)?.focus(), 0);
  }

  function addRow(afterIndex?: number) {
    // Flush current DOM content into rowsRef before splicing
    const current = readRows();
    const newRow = mkRow();
    let next: SRow[];
    let focusAt: number;
    if (afterIndex === undefined) {
      next = [...current, newRow];
      focusAt = next.length - 1;
    } else {
      next = [...current];
      next.splice(afterIndex + 1, 0, newRow);
      focusAt = afterIndex + 1;
    }
    setRows(next);
    setTimeout(() => focusCell(focusAt, 0), 0);
  }

  function confirmDeleteRow(ri: number) {
    const domWord = cellRefs.current.get(`${ri}:0`)?.value ?? rows[ri]?.word ?? '';
    const domSentences = [1, 2, 3].map(ci => cellRefs.current.get(`${ri}:${ci}`)?.value ?? '');
    if (!domWord.trim() && domSentences.every(s => !s.trim())) {
      // Empty row — skip the modal and delete immediately
      const current = readRows();
      const filtered = current.length === 1 ? [mkRow()] : current.filter((_, i) => i !== ri);
      setRows(withTrailing(filtered));
      setTimeout(() => { focusCell(Math.max(0, ri - 1), 0); checkDuplicates(); }, 0);
    } else {
      setDeleteTarget(ri);
    }
  }

  function executeDeleteRow() {
    if (deleteTarget === null) return;
    const ri = deleteTarget;
    setDeleteTarget(null);
    const current = readRows();
    const filtered = current.length === 1 ? [mkRow()] : current.filter((_, i) => i !== ri);
    setRows(withTrailing(filtered));
    setTimeout(() => { focusCell(Math.max(0, ri - 1), 0); checkDuplicates(); }, 0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, ri: number, ci: number) {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        if (ci > 0) focusCell(ri, ci - 1);
        else if (ri > 0) focusCell(ri - 1, COLS - 1);
      } else {
        if (ci < COLS - 1) focusCell(ri, ci + 1);
        else if (ri === rows.length - 1) addRow(ri);
        else focusCell(ri + 1, 0);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      addRow(ri);
    } else if (e.key === 'ArrowUp' && ri > 0) {
      e.preventDefault();
      focusCell(ri - 1, ci);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (ri < rows.length - 1) focusCell(ri + 1, ci);
      else addRow(ri);
    }
  }

  return (
    <>
      {/* Skeleton overlay — covers the screen until the sheet is fully loaded and resized */}
      {!isReady && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[var(--bg-primary)]">
          <div className="px-6 py-4 flex justify-between items-center border-b border-[var(--border-color)]">
            <div className="h-4 w-12 rounded bg-[var(--text-muted)] opacity-20 animate-pulse" />
            <div className="flex items-center gap-4">
              <div className="h-3 w-24 rounded bg-[var(--text-muted)] opacity-20 animate-pulse" />
              <div className="h-3 w-14 rounded bg-[var(--text-muted)] opacity-20 animate-pulse" />
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            <table className="w-full border-collapse text-sm table-fixed">
              <colgroup>
                <col style={{ width: '2.5rem' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '27.3%' }} />
                <col style={{ width: '27.3%' }} />
                <col style={{ width: '27.3%' }} />
                <col style={{ width: '2.5rem' }} />
              </colgroup>
              <thead>
                <tr className="border-b border-[var(--border-color)]">
                  <th className="border-r border-[var(--border-color)] py-2" />
                  {HEADERS.map((_, ci) => (
                    <th key={ci} className="border-r border-[var(--border-color)] px-3 py-2 text-left">
                      <div className="h-2.5 w-14 rounded bg-[var(--text-muted)] opacity-20 animate-pulse" />
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 14 }).map((_, i) => (
                  <tr key={i} className="border-b border-[var(--border-color)]">
                    <td className="border-r border-[var(--border-color)] py-3 text-center">
                      <div className="h-2.5 w-4 rounded bg-[var(--text-muted)] opacity-10 animate-pulse mx-auto" />
                    </td>
                    {[0, 1, 2, 3].map(ci => (
                      <td key={ci} className="border-r border-[var(--border-color)] px-3 py-3">
                        <div
                          className="h-4 rounded bg-[var(--text-muted)] opacity-10 animate-pulse"
                          style={{
                            width: `${[55, 72, 80, 65, 75, 50, 84, 60, 70, 68, 78, 58, 74, 62][i % 14] + ci * 4}%`,
                            animationDelay: `${((i * 4 + ci) * 60) % 500}ms`,
                          }}
                        />
                      </td>
                    ))}
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    <div className={`flex flex-col min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]${!isReady ? ' invisible' : ''}`}>
      <audio ref={audioRef} className="hidden" />

      <header className="sticky top-0 z-10 px-3 sm:px-6 py-3 sm:py-4 flex justify-between items-center border-b border-[var(--border-color)] bg-[var(--bg-primary)]">
        <button
          onClick={() => {
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
            const current = readRows();
            if (isDirtyRef.current) {
              syncToServer(current);
            }
            onBack(cleanRows(current));
          }}
          className="text-base text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          ← Back
        </button>
        <div className="flex items-center gap-2 sm:gap-4 text-sm text-[var(--text-muted)]">
          <button
            onClick={toggleDarkMode}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            title={isDark ? 'Light mode' : 'Dark mode'}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          {hasMissingExamples && (
            <button
              onClick={openGenerateModal}
              className="flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Generate examples</span>
            </button>
          )}
          <span>{wordCount} word{wordCount !== 1 ? 's' : ''}</span>
          {syncStatus === 'pending'            && <Loader2 className="w-3 h-3 animate-spin opacity-40" />}
          {syncStatus === 'offline'            && <span className="text-xs opacity-60">Offline</span>}
          {syncStatus === 'error'              && <span className="text-xs opacity-60">Sync error</span>}
          {syncStatus === 'synced' && showSaved && <span className="text-xs">· Saved</span>}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto pb-[50vh]">
        <table className="w-full border-collapse text-sm table-fixed">
          <colgroup>
            <col style={{ width: '2.5rem' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '27.3%' }} />
            <col style={{ width: '27.3%' }} />
            <col style={{ width: '27.3%' }} />
            <col style={{ width: '2.5rem' }} />
          </colgroup>
          <thead>
            <tr className="border-b border-[var(--border-color)]">
              <th className="border-r border-[var(--border-color)] py-2" />
              {HEADERS.map((h, ci) => (
                <th key={ci} className="border-r border-[var(--border-color)] px-3 py-2 text-left text-xs font-medium text-[var(--text-muted)] tracking-wide uppercase">
                  {h}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={row._id} className="group border-b border-[var(--border-color)]">
                <td className="border-r border-[var(--border-color)] py-2 text-xs text-[var(--text-muted)] text-center align-top select-none">
                  {ri + 1}
                </td>
                {[0, 1, 2, 3].map(ci => {
                  const initialText = ci === 0 ? row.word : (row.sentences[ci - 1] ?? '');
                  const cellKey = `${ri}:${ci}`;
                  return (
                    <td
                      key={ci}
                      className={`border-r border-[var(--border-color)] p-0 relative transition-shadow ${hoveredCell === cellKey ? 'ring-1 ring-inset ring-[var(--text-muted)]' : ''}`}
                      onMouseEnter={() => {
                        hoverSessionRef.current++;
                        setHoveredCell(cellKey);
                        setHoveredCellText(cellRefs.current.get(cellKey)?.value ?? initialText);
                      }}
                      onMouseLeave={() => {
                        hoverSessionRef.current++;
                        const text = cellRefs.current.get(cellKey)?.value ?? initialText;
                        if (text) {
                          setTranslationCache(prev => { const n = { ...prev }; delete n[text]; return n; });
                        }
                        setHoveredCell(null);
                        setHoveredCellText('');
                        setTranslatingText(null);
                      }}
                    >
                      {/* Uncontrolled — React never re-renders this textarea on typing */}
                      <textarea
                        ref={setRef(ri, ci)}
                        defaultValue={initialText}
                        rows={1}
                        onChange={e => {
                          autoResize(e.target);
                          scheduleSave();
                          if (ci === 0) checkDuplicates();
                          // Auto-grow: append a trailing empty row the first time
                          // the user types anything into the last (placeholder) row
                          if (ri === rows.length - 1 && e.target.value.trim()) {
                            setRows(prev => [...prev, mkRow()]);
                          }
                          // Keep hoveredCellText in sync while typing in the hovered cell
                          if (hoveredCell === cellKey) {
                            setHoveredCellText(e.target.value);
                          }
                        }}
                        onKeyDown={e => handleKeyDown(e, ri, ci)}
                        placeholder={ci === 0 ? 'word' : `example ${ci}`}
                        className={`w-full px-2 py-1.5 text-base bg-transparent outline-none resize-none overflow-hidden leading-normal ${ci === 0 ? `font-medium ${duplicateErrors.has(ri) ? 'text-red-500' : ''}` : 'text-[var(--text-secondary)]'} placeholder:text-[var(--text-muted)] placeholder:opacity-40 ${hoveredCell === cellKey && hoveredCellText ? 'pr-14' : ''}`}
                      />
                      {ci === 0 && duplicateErrors.has(ri) && (
                        <p className="px-2 pb-1.5 text-xs text-red-500 leading-tight">
                          Already exists at row {duplicateErrors.get(ri)! + 1}
                        </p>
                      )}
                      {/* Icons inside cell — never block the row below */}
                      {hoveredCell === cellKey && hoveredCellText && (
                        <div
                          className="absolute right-0 top-0 bottom-0 flex items-center gap-0.5 pr-1 pointer-events-none z-10"
                          style={{ background: 'linear-gradient(to right, transparent, var(--bg-primary) 35%)' }}
                        >
                          <button
                            onMouseDown={e => { e.preventDefault(); speak(hoveredCellText); }}
                            className="pointer-events-auto p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                            title="Listen"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onMouseDown={e => { e.preventDefault(); translateCell(hoveredCellText); }}
                            className="pointer-events-auto p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                            title="Translate"
                          >
                            {translatingText === hoveredCellText
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <Languages className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      )}
                      {/* Translation result — only after Translate is clicked; cleared on mouse-leave */}
                      {hoveredCell === cellKey && translationCache[hoveredCellText] && (
                        <div
                          className="absolute left-0 top-full z-30 bg-[var(--bg-primary)] border border-[var(--border-color)] shadow-md px-3 py-2 text-xs text-[var(--text-secondary)] leading-relaxed"
                          style={{ minWidth: '100%', width: 'max-content', maxWidth: '320px' }}
                        >
                          {translationCache[hoveredCellText]}
                        </div>
                      )}
                    </td>
                  );
                })}
                <td className="text-center align-top pt-2">
                  {ri < rows.length - 1 && (
                    <button
                      onClick={() => confirmDeleteRow(ri)}
                      className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all px-2 py-1 text-base leading-none"
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

      </div>

      {/* ── Delete confirmation ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {deleteTarget !== null && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-8 z-50"
            onClick={e => { if (e.target === e.currentTarget) setDeleteTarget(null); }}
          >
            <motion.div
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-xs bg-[var(--bg-primary)] border border-[var(--border-color)] p-6"
            >
              <p className="font-medium mb-1">Delete row?</p>
              {rows[deleteTarget]?.word.trim()
                ? <p className="text-sm text-[var(--text-muted)] mb-6 font-mono truncate">{rows[deleteTarget].word}</p>
                : <p className="text-sm text-[var(--text-muted)] mb-6">This row is empty.</p>
              }
              <div className="flex gap-3">
                <button onClick={() => setDeleteTarget(null)} className="flex-1 py-2 text-sm border border-[var(--border-color)] hover:border-[var(--text-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">Cancel</button>
                <button onClick={executeDeleteRow}           className="flex-1 py-2 text-sm border border-[var(--border-color)] hover:border-[var(--text-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">Delete</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Generate examples modal ─────────────────────────────────────────── */}
      <AnimatePresence>
        {showGenerateModal && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
            onClick={e => { if (e.target === e.currentTarget) setShowGenerateModal(false); }}
          >
            <motion.div
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-2xl bg-[var(--bg-primary)] border border-[var(--border-color)] flex flex-col max-h-[90vh]"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-color)] shrink-0">
                <p className="text-sm font-medium">Generate examples</p>
                <button onClick={() => setShowGenerateModal(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none">×</button>
              </div>

              <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">
                {generatePrompt ? (
                  <>
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs text-[var(--text-muted)] uppercase tracking-widest">AI Prompt</p>
                        <button onClick={copyPrompt} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                          {promptCopied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
                        </button>
                      </div>
                      <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-auto border-l-2 border-[var(--border-color)] pl-4">
                        {generatePrompt}
                      </pre>
                    </div>
                    <div className="border-t border-[var(--border-color)] pt-5 space-y-3">
                      <p className="text-xs text-[var(--text-muted)] uppercase tracking-widest">Paste AI response</p>
                      <textarea
                        value={generatePaste}
                        onChange={e => { setGeneratePaste(e.target.value); setGenerateError(null); }}
                        placeholder="Paste the JSON array here…"
                        className="w-full bg-transparent border border-[var(--border-color)] focus:border-[var(--text-primary)] outline-none p-3 text-sm font-mono min-h-[140px] resize-none transition-colors placeholder:text-[var(--text-muted)]"
                      />
                      {generateError && (
                        <div className="flex items-start gap-2 text-sm text-[var(--text-muted)]">
                          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                          <span>{generateError}</span>
                        </div>
                      )}
                      <button
                        onClick={applyGenerated}
                        disabled={!generatePaste.trim() || applyLoading || applySuccess}
                        className="text-sm underline text-[var(--text-primary)] disabled:opacity-30 flex items-center gap-1.5 transition-opacity"
                      >
                        {applyLoading
                          ? <><Loader2 className="w-4 h-4 animate-spin" /> Applying…</>
                          : applySuccess
                          ? <><Check className="w-4 h-4" /> Applied</>
                          : 'Apply to sheet'}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-[var(--text-muted)]">All rows already have 3 examples.</p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </>
  );
}
