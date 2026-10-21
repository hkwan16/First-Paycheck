import { Card } from '@/components/ui/Card';
import type { Citation } from '@/lib/api/types';

export interface SourcesProps {
  citations: readonly Citation[];
  /** The decision's tax year, which the curated passages are for. */
  taxYear: number | null;
}

/**
 * From the mockup's Sources card: the curated IRS passages the explanation
 * cites, each linking out to the page it was quoted from.
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
            <blockquote className="m-0 mt-0.5 text-tiny text-ink-3">
              &ldquo;{citation.passage}&rdquo;
            </blockquote>
            <div className="text-tiny text-ink-3">
              {citation.source}. Curated citation
              {taxYear === null ? '' : `, tax year ${taxYear}`}.
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
