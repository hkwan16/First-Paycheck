import { cva } from 'class-variance-authority';

/** From the mockup's `.input`, shared by Input and Select. */
export const fieldClasses = cva(
  [
    'w-full rounded-control border border-border bg-surface text-ink',
    'placeholder:text-ink-3 focus:outline-2 focus:outline-offset-1 focus:outline-blue',
    'disabled:cursor-not-allowed disabled:bg-well disabled:text-ink-3',
    'aria-invalid:border-red',
  ],
  {
    variants: {
      size: {
        md: 'min-h-11 px-3 py-2.5 text-body',
        sm: 'min-h-10 px-2.5 py-2 text-control',
      },
    },
    defaultVariants: { size: 'md' },
  },
);
