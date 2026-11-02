import { Card } from '@/components/ui/Card';
import type { Citation } from '@/lib/api/types';

export interface SourcesProps {
  citations: readonly Citation[];
  /** The decision's tax year, which the quoted passages are for. */
  taxYear: number | null;
}

/**
 * From the mockup's Sources card: the IRS pages the explanation relies on,
 * each linking out, with the passage it quotes behind "What it says" so the
 * card stays a list a person can scan (issue 204).
 */
export function Sources({ citations, taxYear }: SourcesProps) {
  if (citations.length === 0) return null;
  return (
    <Card aria-labelledby="sources-title" gap={14}>
      <h2 id="sources-title" className="m-0">
        Sources
      </h2>
      <ol className="m-0 flex list-decimal flex-col gap-2 pl-[22px] text-control marker:font-bold marker:text-coral-text">
        {citations.map((citation) => (
          <li key={citation.key}>
            <a href={citation.url} target="_blank" rel="noopener noreferrer">
              {citation.title} <span className="sr-only">(opens in a new tab)</span>
            </a>
            <div className="text-tiny text-ink-3">
              {citation.source}
              {taxYear === null ? '' : `, tax year ${taxYear}`}.
            </div>
            <details className="text-tiny text-ink-3">
              {/* py-1 keeps the target at least 24px tall (WCAG 2.5.8). */}
              <summary className="cursor-pointer py-1 text-ink-2">What it says</summary>
              <blockquote className="m-0">&ldquo;{citation.passage}&rdquo;</blockquote>
            </details>
          </li>
        ))}
      </ol>
    </Card>
  );
}
