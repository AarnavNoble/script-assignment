// Demo setup helpers. Acts on DATABASE_URL (the `scripts` DB via .env).
//   npx tsx --env-file=.env scripts/demo-setup.ts race [lang]      one claimable script left (default sw)
//   npx tsx --env-file=.env scripts/demo-setup.ts low [lang] [n]   n available scripts left (default es 40)
//   npx tsx --env-file=.env scripts/demo-setup.ts reset            reseed (drops everything)
//   npx tsx --env-file=.env scripts/demo-setup.ts who <lang>       a few contributor ids for a language
// Refuses databases named sa_* (test / simulation DBs) unless --force is passed.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { LANGUAGES, POPULAR, seed } from '../db/seed';
import { config } from '../lib/config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const [cmd, ...args] = argv.filter((a) => a !== '--force');

const USAGE = `usage: npx tsx --env-file=.env scripts/demo-setup.ts <command> [--force]
  race [lang]      leave ONE claimable script in lang (default sw) and print two contributors to race for it
  low [lang] [n]   leave n available scripts in lang (default es 40) so /stats can show the low-pool highlight
  reset            reseed the database (drops all claims, recordings and events)
  who <lang>       print a few contributor ids for lang`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function lang(v: string | undefined, fallback?: string): string {
  const l = v ?? fallback;
  if (!l) fail(`language required, one of: ${LANGUAGES.join(' ')}`);
  if (!LANGUAGES.includes(l)) fail(`unknown language "${l}", expected one of: ${LANGUAGES.join(' ')}`);
  return l;
}

/** Contributors of a language who hold no live lease and have no expired lease that claim() would revive. */
async function freeContributors(c: Client, l: string, n: number): Promise<number[]> {
  const r = await c.query(
    `SELECT id FROM contributors k
     WHERE language = $1
       AND NOT EXISTS (SELECT 1 FROM scripts s WHERE s.claimed_by = k.id OR s.prev_claimed_by = k.id)
     ORDER BY id LIMIT $2`,
    [l, n],
  );
  return r.rows.map((x) => Number(x.id));
}

// Approved straight from the pool (no recording): clears every lease field so the CHECK constraint holds.
const RETIRE = `status = 'approved', claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
  prev_token = NULL, prev_claimed_by = NULL`;

async function race(c: Client, l: string) {
  await c.query('BEGIN');
  const keep = await c.query(
    `SELECT id, body FROM scripts WHERE language = $1 AND status IN ('available','claimed')
     ORDER BY (status = 'available' AND prev_token IS NULL) DESC, id LIMIT 1 FOR UPDATE`,
    [l],
  );
  if (!keep.rowCount) {
    await c.query('ROLLBACK');
    fail(`${l}: no available or claimed scripts to keep. Run "reset" first.`);
  }
  const keepId = Number(keep.rows[0].id);
  // live leases in this language end now; log them so /ops shows why
  const live = await c.query(
    `SELECT id, claimed_by, claim_token FROM scripts
     WHERE language = $1 AND status = 'claimed' AND lease_expires_at > now() FOR UPDATE`,
    [l],
  );
  for (const r of live.rows) {
    await c.query(
      `INSERT INTO claim_events (script_id, contributor_id, claim_token, event, language, lease_expires_at, detail)
       VALUES ($1, $2, $3, 'released', $4, now(), '{"by":"demo-setup"}')`,
      [r.id, r.claimed_by, r.claim_token, l],
    );
  }
  const retired = await c.query(
    `UPDATE scripts SET ${RETIRE} WHERE language = $1 AND status IN ('available','claimed') AND id <> $2`,
    [l, keepId],
  );
  await c.query(
    `UPDATE scripts SET status = 'available', claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
       prev_token = NULL, prev_claimed_by = NULL WHERE id = $1`,
    [keepId],
  );
  const submitted = Number((await c.query(`SELECT count(*) FROM scripts WHERE language = $1 AND status = 'submitted'`, [l])).rows[0].count);
  await c.query('COMMIT');

  const who = await freeContributors(c, l, 2);
  console.log(`${l}: 1 claimable script left (#${keepId}), ${retired.rowCount} marked approved, ${live.rowCount} live lease(s) released.`);
  console.log(`  script #${keepId}: ${keep.rows[0].body}`);
  if (submitted) console.log(`  note: ${submitted} ${l} script(s) are awaiting QA; a QA rejection would put one back in the pool.`);
  if (who.length < 2) fail(`  only ${who.length} free ${l} contributor(s); run "reset" first.`);
  console.log(`
Race for it:
  1. Open http://localhost:3000/record in two windows that don't share storage
     (a normal window and a private one, or two browser profiles).
  2. Window A: contributor ${who[0]}. Window B: contributor ${who[1]}. Language stays ${l} (their usual).
  3. Click "Get script" in both at the same time. One gets script #${keepId}; the other is told no scripts are left.
  To repeat: click "Switch" in both windows first, run "race ${l}" again, then re-enter the ids.
  (A window left on the recorder re-claims on reload, so it would grab the script before the race.)`);
}

async function low(c: Client, l: string, n: number) {
  if (!Number.isInteger(n) || n < 0) fail(`n must be a whole number >= 0, got "${n}"`);
  await c.query('BEGIN');
  // "available" as the forecast counts it: free rows plus expired leases. Live leases are left alone.
  const ids = await c.query(
    `SELECT id FROM scripts
     WHERE language = $1 AND (status = 'available' OR (status = 'claimed' AND lease_expires_at <= now()))
     ORDER BY id OFFSET $2 FOR UPDATE`,
    [l, n],
  );
  const r = await c.query(`UPDATE scripts SET ${RETIRE} WHERE id = ANY($1::bigint[])`, [ids.rows.map((x) => x.id)]);
  await c.query('COMMIT');

  const windowS = config.forecastWindowSeconds();
  const lowHours = config.lowPoolAlertHours();
  const snap = (await c.query(
    `SELECT
       (SELECT count(*) FROM scripts WHERE language = $1
          AND (status = 'available' OR (status = 'claimed' AND lease_expires_at <= now()))) AS available,
       (SELECT count(*) FROM claim_events WHERE language = $1 AND event = 'claimed'
          AND at > now() - make_interval(secs => $2)) AS claims`,
    [l, windowS],
  )).rows[0];
  const available = Number(snap.available);
  const claims = Number(snap.claims);
  const windowH = windowS / 3600;
  // hours_left = available / (claims / windowH) < lowHours  <=>  claims > available * windowH / lowHours
  const need = Math.floor((available * windowH) / lowHours) + 1;
  const hoursLeft = claims > 0 ? available / (claims / windowH) : null;
  const windowText = windowS % 3600 === 0 ? `${windowH} h` : `${Math.round(windowS / 60)} min`;
  console.log(`${l}: ${available} available now (${r.rowCount} marked approved).`);
  if (!POPULAR.includes(l)) console.log(`  note: ${l} is a long-tail language; claims there are rare, so the highlight is slow to appear.`);
  console.log(`
/stats highlights ${l} as low when hours left < ${lowHours} h, where hours left = available / claims per hour
over the last ${windowText}. With ${available} available that takes at least ${need} ${l} claims in the last ${windowText}.
  claims in the window so far: ${claims}${hoursLeft === null ? ' (no forecast yet)' : ` -> ${hoursLeft.toFixed(1)} h left`}
  ${claims >= need ? 'Already low: /stats should show the highlight now.' : `Need ${need - claims} more ${l} claim(s) within the window ("who ${l}" lists contributors; a smaller n needs fewer).`}`);
}

async function who(c: Client, l: string) {
  const free = await freeContributors(c, l, 5);
  const busy = await c.query(
    `SELECT DISTINCT claimed_by AS id FROM scripts s JOIN contributors k ON k.id = s.claimed_by
     WHERE k.language = $1 AND s.status = 'claimed' AND s.lease_expires_at > now() ORDER BY 1 LIMIT 5`,
    [l],
  );
  const total = Number((await c.query('SELECT count(*) FROM contributors WHERE language = $1', [l])).rows[0].count);
  console.log(`${l}: ${total} contributors.`);
  console.log(`  fresh (no current or recent script): ${free.join(', ') || 'none'}`);
  if (busy.rowCount) console.log(`  holding a script right now: ${busy.rows.map((x) => x.id).join(', ')}`);
  console.log(`Type one into http://localhost:3000/record; the language defaults to their usual (${l}).`);
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set (run with --env-file=.env).');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (dbName.startsWith('sa_') && !force) fail(`refusing to run against "${dbName}" (sa_* are test/sim databases). Pass --force to override.`);

  if (cmd === 'reset') {
    process.chdir(ROOT); // seed() reads db/schema.sql relative to cwd
    await seed({ databaseUrl: url });
    console.log(`Reseeded "${dbName}": ${LANGUAGES.length} languages, fresh contributors and scripts, no claims or recordings.
Reload /record, /stats and /ops. A contributor id a browser remembered still works (ids are stable).`);
    return;
  }

  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    if (cmd === 'race') await race(c, lang(args[0], 'sw'));
    else if (cmd === 'low') await low(c, lang(args[0], 'es'), args[1] === undefined ? 40 : Number(args[1]));
    else if (cmd === 'who') await who(c, lang(args[0]));
    else fail(`unknown command "${cmd}"\n${USAGE}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
