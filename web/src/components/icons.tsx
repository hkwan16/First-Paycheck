import type { ReactNode, SVGProps } from 'react';

/**
 * The mockup's inline SVG glyphs. Every icon is decorative (the text next to
 * it carries the meaning), draws in currentColor, and scales from its native
 * viewBox. The default size is the size the mockup draws it at.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
  strokeWidth?: number;
}

function createIcon(
  name: string,
  viewBox: number,
  defaultSize: number,
  defaultStroke: number,
  draw: (stroke: number) => ReactNode,
) {
  function Icon({ size = defaultSize, strokeWidth = defaultStroke, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${viewBox} ${viewBox}`}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...props}
      >
        {draw(strokeWidth)}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

/** The brand mark: a coral rounded square with a white check. */
export function LogoMark({ size = 22, ...props }: Omit<IconProps, 'strokeWidth'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="1" y="1" width="18" height="18" rx="5.5" className="fill-coral" />
      <path
        d="M6 10.5l2.6 2.6L14 7.8"
        className="stroke-white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const CheckIcon = createIcon('CheckIcon', 12, 12, 1.6, (s) => (
  <path d="M2.5 6.5l2.3 2.3L9.5 4" strokeWidth={s} />
));

export const ArrowRightIcon = createIcon('ArrowRightIcon', 16, 16, 1.8, (s) => (
  <path d="M3 8h10M9 4l4 4-4 4" strokeWidth={s} />
));

export const ArrowSmallIcon = createIcon('ArrowSmallIcon', 10, 10, 1.5, (s) => (
  <path d="M2 5h6M5.5 2.5L8 5 5.5 7.5" strokeWidth={s} />
));

export const LinkIcon = createIcon('LinkIcon', 16, 16, 1.6, (s) => (
  <path
    d="M6.5 9.5l3-3M5 11l-1 1a2.1 2.1 0 01-3-3l2-2a2.1 2.1 0 013 0M11 5l1-1a2.1 2.1 0 013 3l-2 2a2.1 2.1 0 01-3 0"
    strokeWidth={s}
  />
));

export const UploadIcon = createIcon('UploadIcon', 28, 28, 1.8, (s) => (
  <path d="M14 18V6M9 11l5-5 5 5M5 18v3a2 2 0 002 2h14a2 2 0 002-2v-3" strokeWidth={s} />
));

const shieldPath = 'M10 2.5l6.5 2.5v4.5c0 3.8-2.8 6.6-6.5 8-3.7-1.4-6.5-4.2-6.5-8V5L10 2.5z';

export const ShieldIcon = createIcon('ShieldIcon', 20, 20, 1.6, (s) => (
  <path d={shieldPath} strokeWidth={s} />
));

export const ShieldCheckIcon = createIcon('ShieldCheckIcon', 20, 20, 1.6, (s) => (
  <>
    <path d={shieldPath} strokeWidth={s} />
    <path d="M7.5 10l1.8 1.8 3.2-3.6" strokeWidth={s} />
  </>
));

export const LinesIcon = createIcon('LinesIcon', 20, 20, 1.8, (s) => (
  <path d="M4 5.5h12M4 10h12M4 14.5h7" strokeWidth={s} />
));

export const CalendarIcon = createIcon('CalendarIcon', 20, 20, 1.6, (s) => (
  <>
    <rect x="2.5" y="4" width="15" height="13" rx="2.5" strokeWidth={s} />
    <path d="M2.5 8.5h15M6.5 2.5v3M13.5 2.5v3" strokeWidth={s} />
  </>
));

export const PlusCircleIcon = createIcon('PlusCircleIcon', 18, 18, 1.6, (s) => (
  <>
    <circle cx="9" cy="9" r="7" strokeWidth={s} />
    <path d="M9 5.5v7M5.5 9h7" strokeWidth={s} />
  </>
));

export const QuestionIcon = createIcon('QuestionIcon', 12, 12, 1.4, (s) => (
  <path d="M6 8.5v-.3c0-.7.4-1 1-1.4.6-.4 1-.8 1-1.5A2 2 0 004 5.3M6 10.3h.01" strokeWidth={s} />
));

export const PlanIcon = createIcon('PlanIcon', 12, 12, 1.4, (s) => (
  <>
    <rect x="2" y="2.5" width="8" height="7.5" rx="1.5" strokeWidth={s} />
    <path d="M2 5h8" strokeWidth={s} />
  </>
));

export const TrendIcon = createIcon('TrendIcon', 12, 12, 1.4, (s) => (
  <path d="M2 9.5l3-3 2 2 3-4" strokeWidth={s} />
));

export const DocumentIcon = createIcon('DocumentIcon', 36, 22, 2.2, (s) => (
  <>
    <rect x="7" y="4" width="22" height="28" rx="4" strokeWidth={s} />
    <path d="M12 13h12M12 18h12M12 23h7" strokeWidth={s} />
  </>
));

export const EditIcon = createIcon('EditIcon', 14, 14, 1.5, (s) => (
  <path d="M9.5 2.5l2 2L5 11H3v-2l6.5-6.5z" strokeWidth={s} />
));

export const AlertIcon = createIcon('AlertIcon', 16, 16, 1.6, (s) => (
  <>
    <path d="M8 5v4M8 11.2h.01" strokeWidth={s + 0.2} />
    <circle cx="8" cy="8" r="6.3" strokeWidth={s} />
  </>
));

export const DownloadIcon = createIcon('DownloadIcon', 16, 16, 1.8, (s) => (
  <path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7M3 13.5h10" strokeWidth={s} />
));

export const RefreshIcon = createIcon('RefreshIcon', 16, 16, 1.6, (s) => (
  <path d="M13 8a5 5 0 01-8.7 3.4M3 8a5 5 0 018.7-3.4M11.5 2v3h-3M4.5 14v-3h3" strokeWidth={s} />
));

export const CloseIcon = createIcon('CloseIcon', 18, 18, 1.8, (s) => (
  <path d="M5 5l8 8M13 5l-8 8" strokeWidth={s} />
));

export const ClockIcon = createIcon('ClockIcon', 18, 18, 1.7, (s) => (
  <path d="M9 3.5v5.5l3 2M9 16.5a7.5 7.5 0 100-15 7.5 7.5 0 000 15z" strokeWidth={s} />
));

export const WarningCircleIcon = createIcon('WarningCircleIcon', 18, 18, 1.7, (s) => (
  <path d="M9 4v5.5M9 12.6h.01M9 16.5a7.5 7.5 0 100-15 7.5 7.5 0 000 15z" strokeWidth={s} />
));

export const ChartIcon = createIcon('ChartIcon', 18, 18, 1.7, (s) => (
  <path d="M3 12.5l4-4 3 3 5-6" strokeWidth={s} />
));

export const CalendarSmallIcon = createIcon('CalendarSmallIcon', 18, 18, 1.7, (s) => (
  <path d="M3.5 5h11v9.5h-11zM3.5 8.5h11M6.5 3v3M11.5 3v3" strokeWidth={s} />
));

export const WhatIfIcon = createIcon('WhatIfIcon', 18, 18, 1.8, (s) => (
  <path d="M3 9h12M10 4l5 5-5 5" strokeWidth={s} />
));

/** Emergency fund. */
export const UmbrellaIcon = createIcon('UmbrellaIcon', 20, 20, 1.7, (s) => (
  <path d="M3 11a7 7 0 0114 0H3zM10 11v4.5a1.5 1.5 0 003 0M10 2.5V4" strokeWidth={s} />
));

/** 401(k). */
export const GrowthIcon = createIcon('GrowthIcon', 20, 20, 1.7, (s) => (
  <path d="M3 15l5-5 3 3 6-7M12 6h5v5" strokeWidth={s} />
));

/** Health plan. */
export const HealthIcon = createIcon('HealthIcon', 20, 20, 1.7, (s) => (
  <>
    <circle cx="10" cy="10" r="7" strokeWidth={s} />
    <path d="M10 6.5v7M6.5 10h7" strokeWidth={s} />
  </>
));

/** W-4. */
export const FormIcon = createIcon('FormIcon', 20, 20, 1.7, (s) => (
  <>
    <rect x="5" y="3" width="10" height="14" rx="2" strokeWidth={s} />
    <path d="M8 8h4M8 11h4M8 14h2" strokeWidth={s} />
  </>
));
