// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHexColors } from './tokens';

const SRC = join(import.meta.dirname, '..', '..');
const GLOBALS = join(SRC, 'app', 'globals.css');

/** The only file allowed to spell a color as hex; the Sankey reads flow colors from tone.ts. */
const HEX_ALLOWED = new Set(['app/globals.css']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const rel = (path: string) => relative(SRC, path).split(sep).join('/');

describe('findHexColors', () => {
  const hash = '#';
  it('finds 3, 4, 6 and 8 digit hex colors', () => {
    const text = `a ${hash}fff b ${hash}16181D c ${hash}1D4ED8CC d ${hash}abcd`;
    expect(findHexColors(text).map((m) => m.match)).toEqual([
      `${hash}fff`,
      `${hash}16181D`,
      `${hash}1D4ED8CC`,
      `${hash}abcd`,
    ]);
  });

  it('ignores fragment links, ids and 5 or 7 digit runs', () => {
    expect(findHexColors(`href="${hash}cite-1" ${hash}main ${hash}12345 ${hash}1234567`)).toEqual(
      [],
    );
  });

  it('reports 1-based line numbers', () => {
    expect(findHexColors(`one\ntwo ${hash}fff`)).toEqual([{ line: 2, match: `${hash}fff` }]);
  });
});

describe('design tokens', () => {
  it('no file under src/ spells a hex color except globals.css', () => {
    const offenders = walk(SRC)
      .filter((path) => !HEX_ALLOWED.has(rel(path)))
      .filter((path) => /\.(tsx?|css|mjs|js|json|svg|html)$/.test(path))
      .flatMap((path) =>
        findHexColors(readFileSync(path, 'utf8')).map(
          ({ line, match }) => `${rel(path)}:${line} ${match}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  const css = readFileSync(GLOBALS, 'utf8');
  const themeStart = css.indexOf('@theme static {');
  const theme = css.slice(themeStart, css.indexOf('}', themeStart));

  it.each([
    'ink',
    'ink-2',
    'ink-3',
    'ground',
    'surface',
    'tile',
    'well',
    'paper',
    'line',
    'fill',
    'fill-strong',
    'border',
    'white',
    'blue-deep',
    'flow-tax',
    'flow-idle',
    'blue-soft',
    'coral-soft',
    ...['blue', 'coral', 'teal', 'plum', 'green', 'amber', 'red'].flatMap((hue) => [
      hue,
      `${hue}-text`,
      `${hue}-tint`,
    ]),
  ])('@theme defines --color-%s', (name) => {
    expect(theme).toMatch(new RegExp(`--color-${name}:`));
  });

  it('@theme resets the default palette so only tokens exist', () => {
    expect(theme).toContain('--color-*: initial;');
  });

  it.each(['card', 'tile', 'control', 'seg', 'node'])('@theme defines --radius-%s', (name) => {
    expect(theme).toMatch(new RegExp(`--radius-${name}:`));
  });

  it.each(['card', 'raised', 'pop', 'paper'])('@theme defines --shadow-%s', (name) => {
    expect(theme).toMatch(new RegExp(`--shadow-${name}:`));
  });

  it.each([
    ['body', '15px'],
    ['small', '13px'],
    ['tiny', '12px'],
    ['title', '28px'],
    ['heading', '17px'],
    ['headline', '20px'],
    ['stat', '22px'],
    ['display', '30px'],
  ])('@theme type scale has --text-%s at %s', (name, size) => {
    expect(theme).toMatch(new RegExp(`--text-${name}: ${size};`));
  });

  it('@theme names the system font stacks', () => {
    expect(theme).toMatch(/--font-sans:\s+-apple-system,/);
    expect(theme).toMatch(/--font-mono:\s+ui-monospace,/);
  });

  it('declares the reduce-transparency variant and reduced-motion handling', () => {
    expect(css).toContain(
      '@custom-variant reduce-transparency (@media (prefers-reduced-transparency: reduce));',
    );
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
