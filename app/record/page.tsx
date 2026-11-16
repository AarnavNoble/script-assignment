import Recorder from '@/components/Recorder';
import { languages } from '@/lib/ops';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Record · Script Recorder' };

export default async function RecordPage() {
  const langs = (await languages()).map((l) => l.language);
  return <Recorder languages={langs} />;
}
