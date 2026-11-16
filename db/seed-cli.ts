// npm run seed [-- --scripts 1200 --contributors 2000]
import { seed } from './seed';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : undefined;
};

seed({ scriptsPerLanguage: arg('scripts'), contributors: arg('contributors') })
  .then(() => console.log(`seeded ${process.env.DATABASE_URL}`))
  .catch((e) => { console.error(e); process.exit(1); });
