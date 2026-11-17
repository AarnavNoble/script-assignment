import type { Metadata } from 'next';
import Link from 'next/link';
import { Geist_Mono, Mona_Sans } from 'next/font/google';
import './globals.css';

// Mona Sans is Latin-only; the --sans stack in globals.css falls back to system-ui for other scripts.
const sans = Mona_Sans({ subsets: ['latin', 'latin-ext'], variable: '--font-mona', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Script Recorder',
  description: 'Claim a script, record it, submit it.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">Script Recorder</Link>
            <nav className="nav">
              <Link href="/record">Record</Link>
              <Link href="/stats">Stats</Link>
              <Link href="/ops">Ops</Link>
              <Link href="/findings">Findings</Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
