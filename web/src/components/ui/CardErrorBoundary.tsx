'use client';

import { Component, Fragment, useId, type ReactNode } from 'react';
import { logErrorOnce } from '@/lib/log-error';
import { Button } from './Button';
import { Card } from './Card';
import { Notice } from './Notice';

export interface CardErrorBoundaryProps {
  /** The card's own title, so the fallback keeps its heading and landmark name. */
  title: string;
  /** The card's layout classes (flex basis, grid placement), kept by the fallback. */
  className?: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
  /** Bumped by Try again: a new key remounts the card from scratch. */
  attempt: number;
}

function CardFallback({
  title,
  className,
  onRetry,
}: {
  title: string;
  className?: string;
  onRetry: () => void;
}) {
  const headingId = useId();
  return (
    <Card aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="m-0">
        {title}
      </h2>
      <Notice tone="blue" compact role="status" className="items-center">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            This card could not be shown. The rest of the page still works, and nothing you saved
            has changed.
          </span>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </Notice>
    </Card>
  );
}

/**
 * One card's error boundary (a class, because React has no hook for one): a
 * render error in the card shows its frame, its title and a calm notice in
 * its place, and the rest of the page keeps working. Try again remounts the
 * card. The error is logged once with `console.error`.
 */
export class CardErrorBoundary extends Component<CardErrorBoundaryProps, State> {
  override state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    logErrorOnce(`[CardErrorBoundary] ${this.props.title} failed to render`, error);
  }

  private retry = () => {
    this.setState(({ attempt }) => ({ failed: false, attempt: attempt + 1 }));
  };

  override render() {
    const { title, className, children } = this.props;
    if (this.state.failed) {
      return <CardFallback title={title} className={className} onRetry={this.retry} />;
    }
    return <Fragment key={this.state.attempt}>{children}</Fragment>;
  }
}
