'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

export default function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send code');
      setStep('code');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid code');
      onLoggedIn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-50 p-6">
      <div className="max-w-sm w-full">
        <h1 className="text-2xl font-bold text-center mb-2">LingoPlayer</h1>
        <p className="text-zinc-500 text-center mb-8">
          {step === 'email' ? 'Sign in with your email' : 'Enter the code sent to your email'}
        </p>

        <form onSubmit={step === 'email' ? sendOtp : verifyOtp} className="space-y-4">
          {step === 'email' ? (
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full p-4 bg-white rounded-2xl border-2 border-zinc-200 focus:border-zinc-900 outline-none transition-colors"
              autoFocus
            />
          ) : (
            <input
              type="text"
              required
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              className="w-full p-4 bg-white rounded-2xl border-2 border-zinc-200 focus:border-zinc-900 outline-none transition-colors text-center text-2xl tracking-[0.3em] font-mono"
              autoFocus
            />
          )}

          {error && (
            <p className="text-red-500 text-sm text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-medium disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {step === 'email' ? 'Send code' : 'Verify'}
          </button>

          {step === 'code' && (
            <button
              type="button"
              onClick={() => { setStep('email'); setCode(''); setError(''); }}
              className="w-full text-center text-sm text-zinc-400 hover:text-zinc-600 py-2"
            >
              ← Use a different email
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
