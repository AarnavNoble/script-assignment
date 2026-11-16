import StatsView from '@/components/StatsView';
import { config } from '@/lib/config';
import { languages } from '@/lib/ops';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Stats · Script Recorder' };

export default async function StatsPage() {
  const langs = await languages(); // ordered by registered contributors: popular languages first
  return <StatsView order={langs.map((l) => l.language)} contributors={Object.fromEntries(langs.map((l) => [l.language, l.contributors]))} lowHours={config.lowPoolAlertHours()} />;
}
