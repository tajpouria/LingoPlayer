'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

interface Row {
  word: string;
  sentences: string[];
}

interface LingoEditorProps {
  deckName: string;
  initialData: Row[];
  onBack: (updatedRows: Row[]) => void;
}

export default function LingoEditor({ deckName, initialData, onBack }: LingoEditorProps) {
  const [rows, setRows] = useState<Row[]>(
    initialData.length > 0 ? initialData : [{ word: '', sentences: [] }]
  );
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const savedTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isFirstRender = useRef(true);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Stable ref map so inputs can be imperatively focused after insertions
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  function setRef(key: string) {
    return (el: HTMLInputElement | null) => {
      if (el) inputRefs.current.set(key, el);
      else inputRefs.current.delete(key);
    };
  }
  function focus(wi: number, si: number | 'word') {
    setTimeout(() => inputRefs.current.get(`${wi}:${si}`)?.focus(), 0);
  }

  // ── Auto-save (debounced 1 s) ──────────────────────────────────────────────

  function cleanRows(r: Row[]) {
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
    setSaveState('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await persist(rows);
        setSaveState('saved');
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaveState('idle'), 2000);
      } catch {
        setSaveState('idle');
      }
    }, 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Flush any pending save on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        persist(rowsRef.current).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────────

  function updateWord(wi: number, value: string) {
    setRows(prev => prev.map((r, i) => i === wi ? { ...r, word: value } : r));
  }

  function removeWord(wi: number) {
    setRows(prev => prev.filter((_, i) => i !== wi));
  }

  function addWord() {
    const wi = rows.length;
    setRows(prev => [...prev, { word: '', sentences: [] }]);
    focus(wi, 'word');
  }

  function updateSentence(wi: number, si: number, value: string) {
    setRows(prev => prev.map((r, i) => i !== wi ? r : {
      ...r,
      sentences: r.sentences.map((s, j) => j === si ? value : s),
    }));
  }

  function insertSentence(wi: number, at: number) {
    setRows(prev => prev.map((r, i) => {
      if (i !== wi) return r;
      const s = [...r.sentences];
      s.splice(at, 0, '');
      return { ...r, sentences: s };
    }));
    focus(wi, at);
  }

  function removeSentence(wi: number, si: number) {
    setRows(prev => prev.map((r, i) => i !== wi ? r : {
      ...r,
      sentences: r.sentences.filter((_, j) => j !== si),
    }));
  }

  // ── Back ───────────────────────────────────────────────────────────────────

  function handleBack() {
    onBack(cleanRows(rows));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <header className="px-8 py-4 flex justify-between items-center border-b border-[var(--border-color)]">
        <button onClick={handleBack} className="text-base text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          ← Back
        </button>
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <span>{rows.filter(r => r.word.trim()).length} words</span>
          {saveState === 'saving' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saveState === 'saved' && <span>· Saved</span>}
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-8">
          {rows.map((row, wi) => (
            <div key={wi} className="border-b border-[var(--border-color)] py-4">

              {/* Word */}
              <div className="flex items-center gap-3">
                <input
                  ref={setRef(`${wi}:word`)}
                  value={row.word}
                  onChange={e => updateWord(wi, e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); insertSentence(wi, row.sentences.length); }
                  }}
                  placeholder="word"
                  className="font-medium text-base bg-transparent outline-none border-b border-transparent focus:border-[var(--border-color)] flex-1 py-0.5 placeholder:text-[var(--text-muted)] transition-colors"
                />
                <button
                  onClick={() => removeWord(wi)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none shrink-0"
                >×</button>
              </div>

              {/* Sentences */}
              <div className="mt-2 pl-4 space-y-1.5">
                {row.sentences.map((s, si) => (
                  <div key={si} className="flex items-center gap-3">
                    <input
                      ref={setRef(`${wi}:${si}`)}
                      value={s}
                      onChange={e => updateSentence(wi, si, e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); insertSentence(wi, si + 1); }
                        if (e.key === 'Backspace' && s === '') { e.preventDefault(); removeSentence(wi, si); focus(wi, si > 0 ? si - 1 : 'word'); }
                      }}
                      placeholder="sentence"
                      className="text-sm text-[var(--text-secondary)] bg-transparent outline-none border-b border-transparent focus:border-[var(--border-color)] flex-1 py-0.5 placeholder:text-[var(--text-muted)] transition-colors"
                    />
                    <button
                      onClick={() => removeSentence(wi, si)}
                      className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-sm shrink-0"
                    >×</button>
                  </div>
                ))}

                <button
                  onClick={() => insertSentence(wi, row.sentences.length)}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors pt-0.5 block"
                >
                  + sentence
                </button>
              </div>
            </div>
          ))}

          <div className="py-8">
            <button
              onClick={addWord}
              className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              + Add word
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
