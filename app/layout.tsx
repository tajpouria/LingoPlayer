import type { Metadata } from 'next';
import '@/src/index.css';
import { DarkModeProvider } from '@/src/DarkModeProvider';

export const metadata: Metadata = {
  title: 'LingoPlayer',
  referrer: 'no-referrer',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <DarkModeProvider>
          {children}
        </DarkModeProvider>
      </body>
    </html>
  );
}
