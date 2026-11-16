import { AppError } from '@/lib/errors';

export function recordingId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'bad_id', 'recording id must be a positive integer');
  return id;
}
