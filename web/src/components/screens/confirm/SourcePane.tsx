'use client';

import { Fragment, useId } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { SourceLine } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/money';
import { redactionParts, splitSourceLine } from './field-format';

/** A redaction drawn as a black bar; it says "Redacted" to a screen reader. */
function Redacted() {
  return (
    <span
      role="img"
      aria-label="Redacted"
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
  lines: readonly SourceLine[];
  redactionCount: number;
  /** Pages never sent to the model because OCR could not redact them safely. */
  withheldPages: readonly number[];
  selectedKey: string | null;
  selectedLabel: string | null;
  /** Manual entry: no field was read from a line, so nothing is highlighted. */
  manual?: boolean;
  className?: string;
}

/**
 * From the mockup's source card: the redacted lines the AI read, as a mono
 * paper panel, with the selected field's line highlighted. Redactions are
 * black bars; the original file is never shown.
 */
export function SourcePane({
  id,
  lines,
  redactionCount,
  withheldPages,
  selectedKey,
  selectedLabel,
  manual = false,
  className,
}: SourcePaneProps) {
  const titleId = useId();
  const multiPage = new Set(lines.map((l) => l.page)).size > 1;
  const hasLine = selectedKey !== null && lines.some((l) => l.field_key === selectedKey);

  return (
    <Card as="aside" id={id} aria-labelledby={titleId} gap={12} className={className}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="m-0">
          Source, as the AI saw it
        </h2>
        <Badge tone={redactionCount > 0 ? 'coral' : 'neutral'}>
          {formatNumber(redactionCount)} {redactionCount === 1 ? 'item' : 'items'} redacted
        </Badge>
      </div>
      {lines.length === 0 ? (
        <p className="m-0 text-small text-ink-3">
          No page could be read safely, so there are no lines to show.
        </p>
      ) : (
        <ol
          aria-label="Redacted pay stub"
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
          {withheldPages.length === 1 ? 'Page' : 'Pages'} {withheldPages.join(', ')}{' '}
          {withheldPages.length === 1 ? 'was' : 'were'} not sent to the AI because it could not be
          redacted safely. Type those fields yourself.
        </p>
      )}
      <p className="m-0 text-tiny text-ink-3" aria-live="polite">
        {manual
          ? 'Type each field from these lines. '
          : selectedLabel !== null &&
            (hasLine ? (
              <>
                Highlighted line: <strong>{selectedLabel}</strong>.{' '}
              </>
            ) : (
              <>{selectedLabel} has no line of its own in the source. </>
            ))}
        Redaction ran before extraction. The original file is deleted when you continue.
      </p>
    </Card>
  );
}
