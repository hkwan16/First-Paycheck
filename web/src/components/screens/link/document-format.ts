import { apiErrorMessage } from '@/lib/api/errors';
import { UploadError } from '@/lib/api/upload';

/* Upload warnings for the Link screen's documents card, as sentences. */

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
    default:
      return `${lead} ${sentence(apiErrorMessage(error, 'Try again'))}`;
  }
}

/** A dropped file the picker would not have offered. */
export const rejectedFileMessage = (name: string) => `${name} was not uploaded. ${ACCEPTED}`;
