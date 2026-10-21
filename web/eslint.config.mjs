import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// Color meaning lives in src/lib/design/tone.ts and the components in
// src/components/ui. Everywhere else, a raw hex color or a status color class
// (green, amber, red) is a bug: green means "confirmed" only, so it is reached
// through tone="confirmed", never by naming the color.
const HEX = '#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])';
const STATUS_CLASS =
  '(?:^|[\\s:!])(?:bg|text|border|fill|stroke|ring|outline|decoration|accent|caret|shadow|from|via|to|divide)-(?:green|amber|red)\\b';

const hexRules = [
  {
    selector: `Literal[value=/${HEX}/]`,
    message: 'No raw hex colors. Use a design token from globals.css (for example bg-blue-tint).',
  },
  {
    selector: `TemplateElement[value.raw=/${HEX}/]`,
    message: 'No raw hex colors. Use a design token from globals.css (for example bg-blue-tint).',
  },
  {
    selector: `JSXText[value=/${HEX}/]`,
    message: 'No raw hex colors. Use a design token from globals.css.',
  },
];

const statusRules = [
  {
    selector: `Literal[value=/${STATUS_CLASS}/]`,
    message:
      'Status colors (green, amber, red) are reachable only through a Tone: use tone="confirmed" | "warning" | "off" on a ui component.',
  },
  {
    selector: `TemplateElement[value.raw=/${STATUS_CLASS}/]`,
    message:
      'Status colors (green, amber, red) are reachable only through a Tone: use tone="confirmed" | "warning" | "off" on a ui component.',
  },
];

const emDashRules = [
  {
    selector: 'Literal[value=/\\u2014/]',
    message: 'Never use an em dash. Use a plain dash "-".',
  },
  {
    selector: 'TemplateElement[value.raw=/\\u2014/]',
    message: 'Never use an em dash. Use a plain dash "-".',
  },
  {
    selector: 'JSXText[value=/\\u2014/]',
    message: 'Never use an em dash. Use a plain dash "-".',
  },
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'src/lib/api/schema.d.ts',
  ]),
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // Everywhere: no em dash in strings or JSX text.
  {
    files: ['**/*.{ts,tsx,mts,mjs}'],
    rules: { 'no-restricted-syntax': ['error', ...emDashRules] },
  },
  // App code outside the design system: no hex, no status color classes.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/components/ui/**', 'src/lib/design/**'],
    rules: { 'no-restricted-syntax': ['error', ...emDashRules, ...hexRules, ...statusRules] },
  },
  // The tone map may name status colors, but never a raw hex.
  {
    files: ['src/lib/design/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...emDashRules, ...hexRules] },
  },
]);
