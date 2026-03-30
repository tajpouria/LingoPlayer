/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SkipForward, SkipBack, Volume2, Loader2, Settings2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Types
interface Row {
  word: string;
  sentences: string[];
}

interface PlayerState {
  rowIndex: number;
  itemIndex: number; // -1 for word, 0+ for sentences
  isPlaying: boolean;
  delay: number; // seconds
}

interface Deck {
  name: string;
  url: string;
}

// Deck Configuration
const DECKS: Deck[] = [
  {
    name: 'Dutch Vocabulary',
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRe6opl5ppH_B3r6TIKO0hVNiHkB2By-RuY1kH1sJQG4wHscGtlrxG_UMjWj-RjlxvFjwkBmBFE69Qb/pub?output=tsv',
  },
  // Add more decks here
];

export default function App() {
  const [selectedDeckIndex, setSelectedDeckIndex] = useState<number | null>(null);
  const [data, setData] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<PlayerState>({
    rowIndex: 0,
    itemIndex: -1,
    isPlaying: false,
    delay: 3,
  });
  const [lang, setLang] = useState('nl');
  const [showSettings, setShowSettings] = useState(false);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Fetch Data
  useEffect(() => {
    if (selectedDeckIndex === null) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(DECKS[selectedDeckIndex].url);
        if (!response.ok) throw new Error('Failed to fetch data');
        const text = await response.text();
        
        const rows = text.split('\n').map(line => {
          const parts = line.split('\t').map(p => p.trim()).filter(p => p.length > 0);
          return {
            word: parts[0] || '',
            sentences: parts.slice(1)
          };
        }).filter(r => r.word);

        setData(rows);
        setState(prev => ({ ...prev, rowIndex: 0, itemIndex: -1, isPlaying: false }));
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        setLoading(false);
      }
    };

    fetchData();
  }, [selectedDeckIndex]);

  const speak = useCallback((text: string, onEnd?: () => void) => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.pause();
    audio.onended = null;
    audio.onerror = null;

    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
    audio.src = url;
    
    audio.onended = () => {
      if (onEnd) onEnd();
    };

    audio.onerror = () => {
      console.error('Audio playback error');
      if (onEnd) onEnd();
    };

    audio.play().catch(err => {
      console.error('Audio playback failed:', err);
      setState(prev => ({ ...prev, isPlaying: false }));
    });
  }, [lang]);

  const nextItem = useCallback(() => {
    setState(prev => {
      const currentRow = data[prev.rowIndex];
      if (!currentRow) return prev;

      // If we are at the word, move to first sentence
      if (prev.itemIndex < currentRow.sentences.length - 1) {
        return { ...prev, itemIndex: prev.itemIndex + 1 };
      } 
      
      // If we are at the last sentence, move to next row's word
      if (prev.rowIndex < data.length - 1) {
        return { ...prev, rowIndex: prev.rowIndex + 1, itemIndex: -1 };
      }

      // End of data
      return { ...prev, isPlaying: false };
    });
  }, [data]);

  const prevItem = useCallback(() => {
    setState(prev => {
      if (prev.itemIndex > -1) {
        return { ...prev, itemIndex: prev.itemIndex - 1 };
      }
      if (prev.rowIndex > 0) {
        const prevRow = data[prev.rowIndex - 1];
        return { ...prev, rowIndex: prev.rowIndex - 1, itemIndex: prevRow.sentences.length - 1 };
      }
      return prev;
    });
  }, [data]);

  // Main Player Loop
  useEffect(() => {
    if (!state.isPlaying || loading || data.length === 0) return;

    const currentRow = data[state.rowIndex];
    if (!currentRow) return;

    const textToSpeak = state.itemIndex === -1 
      ? currentRow.word 
      : currentRow.sentences[state.itemIndex];

    if (!textToSpeak) {
      nextItem();
      return;
    }

    speak(textToSpeak, () => {
      // After speaking, wait for delay then move to next
      timerRef.current = setTimeout(() => {
        nextItem();
      }, state.delay * 1000);
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.onended = null;
      }
    };
  }, [state.isPlaying, state.rowIndex, state.itemIndex, state.delay, data, loading, speak, nextItem]);

  const togglePlay = () => {
    setState(prev => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const repeatCurrent = () => {
    const currentRow = data[state.rowIndex];
    if (!currentRow) return;
    const textToSpeak = state.itemIndex === -1 
      ? currentRow.word 
      : currentRow.sentences[state.itemIndex];
    speak(textToSpeak);
  };

  const changeDeck = () => {
    setSelectedDeckIndex(null);
    setData([]);
    setState(prev => ({ ...prev, rowIndex: 0, itemIndex: -1, isPlaying: false }));
  };

  // Deck Selection Screen
  if (selectedDeckIndex === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 text-zinc-900 p-6">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold mb-2">LingoPlayer</h1>
            <p className="text-zinc-500">Choose a deck to start learning</p>
          </div>
          
          <div className="space-y-3">
            {DECKS.map((deck, index) => (
              <button
                key={index}
                onClick={() => setSelectedDeckIndex(index)}
                className="w-full p-6 bg-white rounded-2xl border-2 border-zinc-200 hover:border-zinc-900 hover:shadow-lg transition-all text-left group"
              >
                <h3 className="font-bold text-lg mb-1 group-hover:text-zinc-900">{deck.name}</h3>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 text-zinc-900 p-6">
        <Loader2 className="w-12 h-12 animate-spin text-zinc-400 mb-4" />
        <p className="font-medium text-zinc-500">Loading your vocabulary...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 text-zinc-900 p-6 text-center">
        <div className="bg-red-50 text-red-600 p-4 rounded-2xl mb-4 max-w-xs">
          <p className="font-bold mb-1">Error</p>
          <p className="text-sm">{error}</p>
        </div>
        <button 
          onClick={() => window.location.reload()}
          className="px-6 py-2 bg-zinc-900 text-white rounded-full font-medium"
        >
          Try Again
        </button>
      </div>
    );
  }

  const currentRow = data[state.rowIndex];
  const currentText = state.itemIndex === -1 
    ? currentRow?.word 
    : currentRow?.sentences[state.itemIndex];

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 text-zinc-900 font-sans selection:bg-zinc-200">
      {/* Hidden Audio Element for TTS */}
      <audio ref={audioRef} className="hidden" />

      {/* Header */}
      <header className="p-6 flex justify-between items-center">
        <div>
          <h1 className="text-xs font-bold uppercase tracking-widest text-zinc-400">{DECKS[selectedDeckIndex!].name}</h1>
          <p className="text-sm font-medium text-zinc-600">
            {state.rowIndex + 1} of {data.length} words
          </p>
        </div>
        <button 
          onClick={() => setShowSettings(!showSettings)}
          className="p-2 rounded-full hover:bg-zinc-200 transition-colors"
        >
          <Settings2 className="w-5 h-5 text-zinc-500" />
        </button>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${state.rowIndex}-${state.itemIndex}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className="max-w-md w-full"
          >
            <div className="mb-4">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400">
                {state.itemIndex === -1 ? 'Word' : `Sentence ${state.itemIndex + 1}`}
              </span>
            </div>
            
            <h2 className={`font-serif leading-tight mb-8 ${state.itemIndex === -1 ? 'text-5xl font-medium' : 'text-3xl italic text-zinc-700'}`}>
              {currentText}
            </h2>

            {state.itemIndex !== -1 && (
              <p className="text-sm text-zinc-400 font-mono mb-4">
                {currentRow.word}
              </p>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Settings Panel */}
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
                <label className="block text-[10px] font-bold uppercase text-zinc-400 mb-2">Current Deck</label>
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-sm font-medium">{DECKS[selectedDeckIndex!].name}</span>
                  <button 
                    onClick={changeDeck}
                    className="px-4 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-lg text-xs font-medium transition-colors"
                  >
                    Change Deck
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold uppercase text-zinc-400 mb-2">Wait between items</label>
                <div className="flex items-center gap-4">
                  <input 
                    type="range" 
                    min="1" 
                    max="10" 
                    step="1"
                    value={state.delay}
                    onChange={(e) => setState(prev => ({ ...prev, delay: parseInt(e.target.value) }))}
                    className="flex-1 accent-zinc-900"
                  />
                  <span className="text-sm font-mono w-8">{state.delay}s</span>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold uppercase text-zinc-400 mb-2">Language</label>
                <select 
                  className="w-full p-3 bg-zinc-50 rounded-xl text-sm border-none focus:ring-2 focus:ring-zinc-200 outline-none"
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                >
                  <option value="nl">Dutch (nl)</option>
                  <option value="en">English (en)</option>
                  <option value="fr">French (fr)</option>
                  <option value="de">German (de)</option>
                  <option value="es">Spanish (es)</option>
                  <option value="it">Italian (it)</option>
                </select>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Controls */}
      <footer className="p-8 pb-12 flex flex-col items-center gap-8">
        <div className="flex items-center justify-center gap-6">
          <button 
            onClick={prevItem}
            className="p-4 rounded-full text-zinc-400 hover:text-zinc-900 hover:bg-zinc-200 transition-all active:scale-95"
            aria-label="Previous"
          >
            <SkipBack className="w-6 h-6" />
          </button>

          <button 
            onClick={togglePlay}
            className="w-20 h-20 flex items-center justify-center rounded-full bg-zinc-900 text-white shadow-xl shadow-zinc-200 hover:scale-105 active:scale-95 transition-all"
            aria-label={state.isPlaying ? 'Pause' : 'Play'}
          >
            {state.isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current ml-1" />}
          </button>

          <button 
            onClick={nextItem}
            className="p-4 rounded-full text-zinc-400 hover:text-zinc-900 hover:bg-zinc-200 transition-all active:scale-95"
            aria-label="Next"
          >
            <SkipForward className="w-6 h-6" />
          </button>
        </div>

        <div className="flex gap-4">
          <button 
            onClick={repeatCurrent}
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-white border border-zinc-200 text-sm font-medium hover:bg-zinc-50 active:scale-95 transition-all"
          >
            <Volume2 className="w-4 h-4" />
            Repeat
          </button>
        </div>
      </footer>
    </div>
  );
}
