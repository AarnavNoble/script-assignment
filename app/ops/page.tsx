import OpsView from '@/components/OpsView';
import { languages } from '@/lib/ops';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ops · Script Recorder' };

export default async function OpsPage() {
  const langs = await languages();
  return <OpsView order={langs.map((l) => l.language)} />;
}
