import type { Metadata } from 'next';
import '@/src/index.css';

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
