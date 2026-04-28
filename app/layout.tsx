import type { Metadata, Viewport } from 'next';
import '@/src/index.css';
import { DarkModeProvider } from '@/src/DarkModeProvider';

export const viewport: Viewport = {
  themeColor: '#f9f7f4',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'Carnet',
  referrer: 'no-referrer',
  appleWebApp: {
    capable: true,
    title: 'Carnet',
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
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
