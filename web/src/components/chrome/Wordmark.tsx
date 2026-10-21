import Link from 'next/link';
import { LogoMark } from '@/components/icons';

/** From the mockup's `.wordmark`. */
export function Wordmark() {
  return (
    <Link
      href="/"
      aria-label="First Paycheck home"
      className="inline-flex flex-none items-center gap-2 text-body font-semibold tracking-[-0.01em] whitespace-nowrap text-ink no-underline hover:text-ink"
    >
      <LogoMark size={22} />
      First Paycheck
    </Link>
  );
}
