import { describe, expect, it } from 'vitest';
import {
  FLOW_COLORS,
  HUES,
  STATUSES,
  TONES,
  flowBg,
  flowFill,
  flowRing,
  isQuietFlow,
  isStatus,
  toneFill,
  toneSoft,
  toneSolid,
  toneText,
  toneWash,
  type Tone,
} from './tone';

const maps = { toneSoft, toneSolid, toneText, toneFill, toneWash };

describe('tone', () => {
  it('lists hues for things and statuses for states', () => {
    expect(HUES).toEqual(['blue', 'coral', 'teal', 'plum', 'neutral']);
    expect(STATUSES).toEqual(['confirmed', 'warning', 'off']);
    expect(TONES).toEqual([...HUES, ...STATUSES]);
  });

  it('isStatus separates states from hues', () => {
    expect(TONES.filter(isStatus)).toEqual(['confirmed', 'warning', 'off']);
  });

  it.each(Object.entries(maps))('%s covers every tone with a non-empty class string', (_, map) => {
    for (const tone of TONES) expect(map[tone]).toMatch(/\S/);
  });

  it.each(Object.entries(maps))(
    '%s reaches green only through confirmed, amber through warning, red through off',
    (_, map) => {
      const owner: Record<string, Tone> = { green: 'confirmed', amber: 'warning', red: 'off' };
      for (const tone of TONES) {
        for (const [color, allowed] of Object.entries(owner)) {
          if (tone !== allowed) expect(map[tone]).not.toMatch(new RegExp(`-${color}\\b`));
        }
      }
    },
  );

  it('pairs each tint with its darker text color', () => {
    expect(toneSoft.blue).toBe('bg-blue-tint text-blue-text');
    expect(toneSoft.confirmed).toBe('bg-green-tint text-green-text');
    expect(toneSoft.warning).toBe('bg-amber-tint text-amber-text');
    expect(toneSoft.off).toBe('bg-red-tint text-red-text');
    expect(toneSoft.neutral).toBe('bg-fill text-ink-2');
  });

  it('keeps white text on solids at 4.5:1 by using the dark pair where the hue is light', () => {
    expect(toneSolid.confirmed).toBe('bg-green text-white');
    expect(toneSolid.warning).toBe('bg-amber-text text-white');
    expect(toneSolid.coral).toBe('bg-coral-text text-white');
    expect(toneSolid.teal).toBe('bg-teal-text text-white');
  });
});

describe('flow colors', () => {
  it('are the Sankey token names: hues for things, quiet greys for taxes and idle money', () => {
    expect(FLOW_COLORS).toEqual([
      'blue',
      'coral',
      'teal',
      'plum',
      'ink-2',
      'flow-tax',
      'flow-idle',
      'blue-soft',
      'coral-soft',
    ]);
  });

  it.each(Object.entries({ flowBg, flowFill, flowRing }))(
    '%s maps every flow color to its token class and never to a status color',
    (_, map) => {
      for (const color of FLOW_COLORS) {
        expect(map[color]).toMatch(new RegExp(`-${color}$`));
        expect(map[color]).not.toMatch(/-(green|amber|red)\b/);
      }
    },
  );

  it('marks the greys as quiet, so their bands are drawn lighter', () => {
    expect(FLOW_COLORS.filter(isQuietFlow)).toEqual(['ink-2', 'flow-tax', 'flow-idle']);
  });
});
