import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Script Recorder',
  description: 'Claim a script, record it, submit it.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">Script Recorder</Link>
            <nav className="nav">
              <Link href="/record">Record</Link>
              <Link href="/stats">Stats</Link>
              <Link href="/ops">Ops</Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
