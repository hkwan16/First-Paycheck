'use client';

import { Fragment, memo, useId } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { DocumentType, SourceLine } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { documentTypeLabel, hiddenText } from '@/lib/documents';
import { redactionParts, splitSourceLine } from './field-format';

/** A hidden number drawn as a black bar; a screen reader hears "Hidden number". */
function Redacted() {
  return (
    <span
      role="img"
      aria-label="Hidden number"
      className="inline-block rounded-xs bg-ink text-transparent select-none"
    >
      XXXXXXXX
    </span>
  );
}

function Text({ text }: { text: string }) {
  return (
    <>
      {redactionParts(text).map((part, index) =>
        part.redacted ? <Redacted key={index} /> : <Fragment key={index}>{part.text}</Fragment>,
      )}
    </>
  );
}

export interface SourcePaneProps {
  id: string;
  /** What the document is: the pane is titled "Your pay stub". */
  type: DocumentType;
  /** The redacted lines, as the proposal has them (none when it has none). */
  lines?: readonly SourceLine[];
  redactionCount: number;
  /** Pages never sent to the model because OCR could not redact them safely. */
  withheldPages?: readonly number[];
  selectedKey: string | null;
  selectedLabel: string | null;
  /** Manual entry: no field was read from a line, so nothing is highlighted. */
  manual?: boolean;
  /**
   * Whether the document's lines name the field read from them. A benefits
   * summary's do not (spec 013), so nothing is highlighted and the pane says so.
   */
  linked?: boolean;
  className?: string;
}

/**
 * From the mockup's source card: the document's lines with private numbers
 * hidden, as a mono paper panel, with the selected field's line highlighted.
 * It is titled after the document ("Your pay stub"), so it never claims the
 * lines were read (spec 004 rule 37). Hidden numbers are black bars; the
 * original file is never shown. Memoized: a keystroke in a field changes
 * none of its props, so the pane renders again only when the selection moves.
 */
export const SourcePane = memo(function SourcePane({
  id,
  type,
  lines = [],
  redactionCount,
  withheldPages = [],
  selectedKey,
  selectedLabel,
  manual = false,
  linked = true,
  className,
}: SourcePaneProps) {
  const titleId = useId();
  const noun = documentTypeLabel(type);
  const multiPage = new Set(lines.map((l) => l.page)).size > 1;
  const hasLine = selectedKey !== null && lines.some((l) => l.field_key === selectedKey);

  return (
    <Card as="aside" id={id} aria-labelledby={titleId} gap={12} className={className}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="m-0">
          Your {noun.toLowerCase()}
        </h2>
        <Badge tone={redactionCount > 0 ? 'coral' : 'neutral'}>{hiddenText(redactionCount)}</Badge>
      </div>
      {lines.length === 0 ? (
        <p className="m-0 text-small text-ink-3">
          We could not read any page safely, so there is no text to show.
        </p>
      ) : (
        <ol
          aria-label={`${noun} text`}
          className="m-0 list-none rounded-seg border border-ink/12 bg-paper p-4 font-mono text-code text-ink"
        >
          {lines.map((line, index) => {
            const { label, value } = splitSourceLine(line.text);
            const current = selectedKey !== null && line.field_key === selectedKey;
            const newPage = multiPage && (index === 0 || lines[index - 1]!.page !== line.page);
            return (
              <li
                key={index}
                aria-current={current ? 'true' : undefined}
                className={cn(newPage && index > 0 && 'mt-3')}
              >
                {newPage && (
                  <div className="mb-1 font-sans text-tiny text-ink-3">Page {line.page}</div>
                )}
                <div
                  className={cn(
                    '-mx-1.5 flex justify-between gap-3 rounded-node px-1.5 py-0.5',
                    current && 'bg-blue-tint outline-2 -outline-offset-2 outline-blue',
                  )}
                >
                  <span className="min-w-0 break-words">
                    <Text text={label} />
                  </span>
                  {value !== null && (
                    <span className="flex-none tabular-nums">
                      <Text text={value} />
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {withheldPages.length > 0 && (
        <p className="m-0 text-small text-ink-2">
          {withheldPages.length === 1
            ? `We could not hide the private numbers on page ${withheldPages[0]}, so we did not read it. Type what it shows yourself.`
            : `We could not hide the private numbers on pages ${withheldPages.join(', ')}, so we did not read them. Type what they show yourself.`}
        </p>
      )}
      <p className="m-0 text-tiny text-ink-3" aria-live="polite">
        {manual
          ? 'Type each amount from these lines. '
          : !linked
            ? 'Find each value in these lines. '
            : selectedLabel !== null &&
              (hasLine ? (
                <>
                  <strong>{selectedLabel}</strong> is highlighted.{' '}
                </>
              ) : (
                <>{selectedLabel} is not on a line of its own. </>
              ))}
        Private numbers are hidden. We delete the file when you continue.
      </p>
    </Card>
  );
});
