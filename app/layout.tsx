import type { Metadata } from 'next';
import '@/src/index.css';
import { DarkModeProvider } from '@/src/DarkModeProvider';

export const metadata: Metadata = {
  title: 'LingoPlayer',
  referrer: 'no-referrer',
  icons: {
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🎧</text></svg>',
  },
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
