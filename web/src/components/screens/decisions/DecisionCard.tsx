import type { ReactNode } from 'react';
import { FormIcon, GrowthIcon, HealthIcon, UmbrellaIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { IconTile } from '@/components/ui/IconTile';
import { CALCULATOR_KINDS, CALCULATOR_LABELS } from '@/lib/decisions';
import type { Hue } from '@/lib/design/tone';
import type { CalculatorId } from '@/lib/features';

/** Each calculator's glyph, hue (lib/design/tone.ts) and one line on what it decides. */
export const CALCULATOR_CARDS: Record<
  CalculatorId,
  { icon: ReactNode; tone: Hue; summary: string }
> = {
  emergency_fund: {
    icon: <UmbrellaIcon />,
    tone: 'teal',
    summary: 'How many months of essentials to hold, and when you will have them.',
  },
  '401k_match': {
    icon: <GrowthIcon />,
    tone: 'plum',
    summary: "Which contribution earns your employer's full match, and what it costs a paycheck.",
  },
  health_plan: {
    icon: <HealthIcon />,
    tone: 'coral',
    summary: 'Which plan costs less at the care you expect.',
  },
  w4: {
    icon: <FormIcon />,
    tone: 'blue',
    summary: 'What to put on your W-4 so tax time comes out about even.',
  },
};

export const calculatorTitle = (calculator: CalculatorId) =>
  CALCULATOR_LABELS[CALCULATOR_KINDS[calculator]];

export interface DecisionCardProps {
  /** Prefix for the heading id the card is labeled by. */
  id: string;
  title: string;
  icon: ReactNode;
  tone: Hue;
  /** The save state or availability, at the end of the title row. */
  badge?: ReactNode;
  /** Greys the glyph, for a calculator that is not available. */
  muted?: boolean;
  /** The calculator's data is on its way. */
  busy?: boolean;
  children: ReactNode;
}

/** From the mockup's decision `.card`: glyph, title and badge, then the calculator. */
export function DecisionCard({
  id,
  title,
  icon,
  tone,
  badge,
  muted = false,
  busy,
  children,
}: DecisionCardProps) {
  const headingId = `${id}-title`;
  return (
    <Card aria-labelledby={headingId} aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <IconTile tone={tone} muted={muted}>
            {icon}
          </IconTile>
          <h2 id={headingId} className="m-0">
            {title}
          </h2>
        </div>
        {badge}
      </div>
      {children}
    </Card>
  );
}

export interface PlaceholderCardProps {
  calculator: CalculatorId;
  /**
   * Whether the calculator is on in this build (`features.calculators`). Off:
   * it arrives after the alpha. On: its card is not built yet.
   */
  live: boolean;
}

/** A calculator without its card: muted, with what it will decide and when. */
export function PlaceholderCard({ calculator, live }: PlaceholderCardProps) {
  const { icon, tone, summary } = CALCULATOR_CARDS[calculator];
  return (
    <DecisionCard
      id={calculator}
      title={calculatorTitle(calculator)}
      icon={icon}
      tone={tone}
      muted
      badge={<Badge>{live ? 'Coming later' : 'After alpha'}</Badge>}
    >
      <p className="m-0 text-small text-ink-3">
        {summary}{' '}
        {live ? 'Coming in a later milestone.' : 'This calculator arrives after the alpha.'}
      </p>
    </DecisionCard>
  );
}
