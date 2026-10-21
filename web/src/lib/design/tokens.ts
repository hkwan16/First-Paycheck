/**
 * A CSS hex color: 3, 4, 6 or 8 hex digits not followed by another word
 * character, so `#cite-1`, `#main` and `#12345` do not count.
 */
const HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;

export interface HexMatch {
  line: number;
  match: string;
}

/** Every hex color in `text`, with its 1-based line number. */
export function findHexColors(text: string): HexMatch[] {
  return text
    .split('\n')
    .flatMap((content, index) =>
      [...content.matchAll(HEX_COLOR)].map((m) => ({ line: index + 1, match: m[0] })),
    );
}
