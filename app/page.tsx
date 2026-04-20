'use client';

import { useState, useEffect } from 'react';
import App from '@/src/App';
import LoginForm from '@/src/LoginForm';

export default function Page() {
  const [user, setUser] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        setUser(data.email);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => { checkAuth(); }, []);

  if (checking) return null;

  if (!user) {
    return <LoginForm onLoggedIn={checkAuth} />;
  }

  return <App />;
}
