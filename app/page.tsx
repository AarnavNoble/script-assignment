import Link from 'next/link';
import styles from './page.module.css';

const LINKS = [
  { href: '/record', title: 'Record', text: 'Claim a script, read it aloud, listen back and submit. Your script is held for you while the page is open.' },
  { href: '/stats', title: 'Stats', text: 'Scripts left per language and how many hours each pool will last at the current claim rate.' },
  { href: '/ops', title: 'Ops', text: 'Live and stuck leases, script history, abandonment, the review queue and payouts.' },
];

export default function Home() {
  return (
    <main className="page page-narrow">
      <h1>Script Recorder</h1>
      <p className="sub">Each script is recorded by exactly one contributor. A claim is a short lease that the open page keeps alive.</p>
      <div className={styles.links}>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={styles.link}>
            <span className={styles.title}>{l.title} →</span>
            <span className="muted small">{l.text}</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
