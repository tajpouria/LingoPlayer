'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Loader2, Plus, Volume2, Languages } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

interface Row {
  word: string;
  sentences: string[];
}

interface DeckSheetProps {
  deckName: string;
  lang: string;
  onBack: (updatedRows: Row[]) => void;
}

const HEADERS = ['Word', 'Example 1', 'Example 2', 'Example 3'];
const COLS = 4;

// Must stay in sync with cell_hash() in generate_audio.py.
function cellHash(language: string, text: string): string {
  const bytes = new TextEncoder().encode(`${language}:${text}`);
  let h = 2166136261;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export default function DeckSheet({ deckName, lang, onBack }: DeckSheetProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);

  // Cell hover popup state
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({});
  const [translatingText, setTranslatingText] = useState<string | null>(null);

  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const savedTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isFirstRender = useRef(true);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const cellRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    fetch(`/api/deck-data?deck=${encodeURIComponent(deckName)}`)
      .then(r => r.json())
      .then((data: Row[]) => {
        if (Array.isArray(data) && data.length > 0) {
          setRows(data.map(r => ({ word: r.word, sentences: [...r.sentences] })));
        } else {
          setRows([{ word: '', sentences: ['', '', ''] }]);
        }
      })
      .catch(() => setRows([{ word: '', sentences: ['', '', ''] }]))
      .finally(() => setLoading(false));
  }, [deckName]);

  function cleanRows(r: Row[]): Row[] {
    return r
      .filter(row => row.word.trim())
      .map(row => ({ word: row.word.trim(), sentences: row.sentences.filter(s => s.trim()) }));
  }

  async function persist(r: Row[]) {
    await fetch('/api/deck-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deck: deckName, rows: cleanRows(r) }),
    });
  }

  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    if (loading) return;
    setSaveState('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await persist(rowsRef.current);
        setSaveState('saved');
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaveState('idle'), 2000);
      } catch {
        setSaveState('idle');
      }
    }, 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, loading]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        persist(rowsRef.current).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      .then((data: { url?: string } | null) => {
        audio.src = data?.url ?? fallbackSrc;
        audio.play().catch(() => {});
      })
      .catch(() => {
        audio.src = fallbackSrc;
        audio.play().catch(() => {});
      });
  }, [lang]);

  // ── Translate ─────────────────────────────────────────────────────────────────

  async function translateCell(text: string) {
    if (translationCache[text] || translatingText === text) return;
    setTranslatingText(text);
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, to: 'en' }),
      });
      const data = await res.json() as { translation?: string };
      setTranslationCache(prev => ({ ...prev, [text]: data.translation ?? 'Translation failed' }));
    } catch {
      setTranslationCache(prev => ({ ...prev, [text]: 'Translation failed' }));
    } finally {
      setTranslatingText(null);
    }
  }

  // ── Cell helpers ──────────────────────────────────────────────────────────────

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  // Resize every cell synchronously after each render so wrapped content is
  // always fully visible — covers both initial load and mid-edit wrapping.
  useLayoutEffect(() => {
    cellRefs.current.forEach(el => autoResize(el));
  }, [rows]);

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

  function getCellValue(row: Row, ci: number): string {
    if (ci === 0) return row.word;
    return row.sentences[ci - 1] ?? '';
  }

  function setCellValue(ri: number, ci: number, value: string) {
    setRows(prev => prev.map((r, i) => {
      if (i !== ri) return r;
      if (ci === 0) return { ...r, word: value };
      const sentences = [...r.sentences];
      while (sentences.length < 3) sentences.push('');
      sentences[ci - 1] = value;
      return { ...r, sentences };
    }));
  }

  function addRow(afterIndex?: number) {
    const newRow: Row = { word: '', sentences: ['', '', ''] };
    if (afterIndex === undefined) {
      setRows(prev => {
        const next = [...prev, newRow];
        setTimeout(() => focusCell(next.length - 1, 0), 0);
        return next;
      });
    } else {
      setRows(prev => {
        const next = [...prev];
        next.splice(afterIndex + 1, 0, newRow);
        setTimeout(() => focusCell(afterIndex + 1, 0), 0);
        return next;
      });
    }
  }

  function confirmDeleteRow(ri: number) {
    setDeleteTarget(ri);
  }

  function executeDeleteRow() {
    if (deleteTarget === null) return;
    const ri = deleteTarget;
    setDeleteTarget(null);
    setRows(prev => {
      if (prev.length === 1) return [{ word: '', sentences: ['', '', ''] }];
      const next = prev.filter((_, i) => i !== ri);
      setTimeout(() => focusCell(Math.max(0, ri - 1), 0), 0);
      return next;
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, ri: number, ci: number) {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        if (ci > 0) focusCell(ri, ci - 1);
        else if (ri > 0) focusCell(ri - 1, COLS - 1);
      } else {
        if (ci < COLS - 1) {
          focusCell(ri, ci + 1);
        } else {
          if (ri === rows.length - 1) addRow(ri);
          else focusCell(ri + 1, 0);
        }
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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  const wordCount = cleanRows(rows).length;

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <audio ref={audioRef} className="hidden" />

      <header className="sticky top-0 z-10 px-6 py-4 flex justify-between items-center border-b border-[var(--border-color)] bg-[var(--bg-primary)]">
        <button
          onClick={() => onBack(cleanRows(rows))}
          className="text-base text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          ← Back
        </button>
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <span>{wordCount} word{wordCount !== 1 ? 's' : ''}</span>
          {saveState === 'saving' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saveState === 'saved' && <span>· Saved</span>}
        </div>
      </header>

      <div className="flex-1 overflow-auto">
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
                <th
                  key={ci}
                  className="border-r border-[var(--border-color)] px-3 py-2 text-left text-xs font-medium text-[var(--text-muted)] tracking-wide uppercase"
                >
                  {h}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="group border-b border-[var(--border-color)]">
                <td className="border-r border-[var(--border-color)] py-2 text-xs text-[var(--text-muted)] text-center align-top select-none">
                  {ri + 1}
                </td>
                {[0, 1, 2, 3].map(ci => {
                  const text = getCellValue(row, ci);
                  const cellKey = `${ri}:${ci}`;
                  return (
                    <td
                      key={ci}
                      className="border-r border-[var(--border-color)] p-0 relative"
                      onMouseEnter={() => setHoveredCell(cellKey)}
                      onMouseLeave={() => setHoveredCell(null)}
                    >
                      <textarea
                        ref={setRef(ri, ci)}
                        value={text}
                        rows={1}
                        onChange={e => { setCellValue(ri, ci, e.target.value); autoResize(e.target); }}
                        onKeyDown={e => handleKeyDown(e, ri, ci)}
                        placeholder={ci === 0 ? 'word' : `example ${ci}`}
                        className={`w-full px-3 py-2 bg-transparent outline-none focus:bg-[var(--border-color)] resize-none overflow-hidden leading-normal ${ci === 0 ? 'font-medium' : 'text-[var(--text-secondary)]'} placeholder:text-[var(--text-muted)] placeholder:opacity-40`}
                      />
                      {hoveredCell === cellKey && text && (
                        <div className="absolute left-0 top-full z-30 bg-[var(--bg-primary)] border border-[var(--border-color)] shadow-md" style={{ minWidth: '100%', width: 'max-content', maxWidth: '320px' }}>
                          <div className="flex items-center gap-0.5 p-1">
                            <button
                              onMouseDown={e => { e.preventDefault(); speak(text); }}
                              className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-color)] rounded transition-colors"
                            >
                              <Volume2 className="w-3.5 h-3.5" />
                              <span>Listen</span>
                            </button>
                            <button
                              onMouseDown={e => { e.preventDefault(); translateCell(text); }}
                              className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-color)] rounded transition-colors"
                            >
                              {translatingText === text
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <Languages className="w-3.5 h-3.5" />}
                              <span>Translate</span>
                            </button>
                          </div>
                          {translationCache[text] && (
                            <div className="px-3 py-2 text-xs text-[var(--text-secondary)] border-t border-[var(--border-color)] leading-relaxed">
                              {translationCache[text]}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
                <td className="text-center">
                  <button
                    onClick={() => confirmDeleteRow(ri)}
                    className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all px-2 py-1 text-base leading-none"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button
          onClick={() => addRow()}
          className="flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors px-6 py-4"
        >
          <Plus className="w-3.5 h-3.5" />
          Add row
        </button>
      </div>

      <AnimatePresence>
        {deleteTarget !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-8 z-50"
            onClick={e => { if (e.target === e.currentTarget) setDeleteTarget(null); }}
          >
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-xs bg-[var(--bg-primary)] border border-[var(--border-color)] p-6"
            >
              <p className="font-medium mb-1">Delete row?</p>
              {rows[deleteTarget]?.word.trim() && (
                <p className="text-sm text-[var(--text-muted)] mb-6 font-mono truncate">
                  {rows[deleteTarget].word}
                </p>
              )}
              {!rows[deleteTarget]?.word.trim() && (
                <p className="text-sm text-[var(--text-muted)] mb-6">This row is empty.</p>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="flex-1 py-2 text-sm border border-[var(--border-color)] hover:border-[var(--text-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={executeDeleteRow}
                  className="flex-1 py-2 text-sm border border-[var(--border-color)] hover:border-[var(--text-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
