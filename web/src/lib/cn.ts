import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge taught the token names in globals.css. Without this it reads
 * `text-small` as a text color and drops it next to `text-ink-3`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        'micro',
        'code',
        'tiny',
        'small',
        'control',
        'body',
        'lead',
        'heading',
        'headline',
        'stat',
        'title',
        'display',
      ],
      radius: ['card', 'tile', 'control', 'seg', 'node'],
      shadow: ['hairline', 'thumb', 'card', 'raised', 'pop', 'paper'],
      breakpoint: ['nav', 'wide'],
    },
  },
});

/** Join class names, letting later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
