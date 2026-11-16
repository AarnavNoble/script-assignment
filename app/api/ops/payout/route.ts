import { handle } from '@/lib/http';
import { markPaid } from '@/lib/review';

/** POST /api/ops/payout — approved -> paid for every approved recording; logs a 'paid' event. */
export async function POST() {
  return handle(markPaid);
}
