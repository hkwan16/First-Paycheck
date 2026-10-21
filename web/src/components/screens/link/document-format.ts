import { apiErrorMessage } from '@/lib/api/errors';
import { UploadError } from '@/lib/api/upload';

/* Upload warnings for the Link screen's documents card, as sentences. */

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "in about 20 minutes", from a Retry-After in seconds; "later" when unknown. */
export function formatWait(seconds: number | null): string {
  if (seconds === null) return 'later';
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${plural(seconds, 'second')}`;
  if (seconds < 3600) return `in about ${plural(Math.ceil(seconds / 60), 'minute')}`;
  return `in about ${plural(Math.ceil(seconds / 3600), 'hour')}`;
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const ACCEPTED = 'Upload a PDF, PNG or JPEG.';

/** A warning for a failed upload, naming the file and what to do next. */
export function uploadErrorMessage(name: string, error: unknown): string {
  const lead = `${name} was not uploaded.`;
  const status = error instanceof UploadError ? error.status : null;
  switch (status) {
    case 0:
      return `${lead} Check your connection and try again.`;
    case 413:
      return `${lead} ${sentence(apiErrorMessage(error, 'The file is too large'))} Try a smaller scan.`;
    case 415:
      return `${lead} ${sentence(apiErrorMessage(error, ACCEPTED))}`;
    case 429: {
      const wait = formatWait((error as UploadError).retryAfterSeconds);
      return `${lead} You have reached the upload limit for now. Try again ${wait}.`;
    }
    default:
      return `${lead} ${sentence(apiErrorMessage(error, 'Try again'))}`;
  }
}

/** A dropped file the picker would not have offered. */
export const rejectedFileMessage = (name: string) => `${name} was not uploaded. ${ACCEPTED}`;
