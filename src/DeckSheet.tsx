'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

interface Row {
  word: string;
  sentences: string[];
}

interface DeckSheetProps {
  deckName: string;
  onBack: (updatedRows: Row[]) => void;
}

const HEADERS = ['Word', 'Example 1', 'Example 2', 'Example 3'];
const COLS = 4;

export default function DeckSheet({ deckName, onBack }: DeckSheetProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);

  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const savedTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isFirstRender = useRef(true);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const cellRefs = useRef<Map<string, HTMLInputElement>>(new Map());

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

  function setRef(ri: number, ci: number) {
    return (el: HTMLInputElement | null) => {
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>, ri: number, ci: number) {
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
                <td className="border-r border-[var(--border-color)] py-1.5 text-xs text-[var(--text-muted)] text-center select-none">
                  {ri + 1}
                </td>
                {[0, 1, 2, 3].map(ci => (
                  <td key={ci} className="border-r border-[var(--border-color)] p-0">
                    <input
                      ref={setRef(ri, ci)}
                      value={getCellValue(row, ci)}
                      onChange={e => setCellValue(ri, ci, e.target.value)}
                      onKeyDown={e => handleKeyDown(e, ri, ci)}
                      placeholder={ci === 0 ? 'word' : `example ${ci}`}
                      className={`w-full px-3 py-2 bg-transparent outline-none focus:bg-[var(--border-color)] ${ci === 0 ? 'font-medium' : 'text-[var(--text-secondary)]'} placeholder:text-[var(--text-muted)] placeholder:opacity-40`}
                    />
                  </td>
                ))}
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
