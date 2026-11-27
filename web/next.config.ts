import type { NextConfig } from 'next';
import { parseFeatures } from './src/lib/features';

// `pnpm e2e` starts `next dev` with NEXT_PUBLIC_FEATURES=e2e,...; read here, at config
// time, the flag tells the dev server itself that it is serving the Playwright run.
const { e2e } = parseFeatures(process.env.NEXT_PUBLIC_FEATURES);

const nextConfig: NextConfig = {
  typedRoutes: true,
  cacheComponents: true,
  partialPrefetching: true,
  // The dev indicator would otherwise land in the Playwright screenshots,
  // which run against `next dev` so that /dev/kit is reachable.
  devIndicators: false,
  // `devIndicators: false` still draws the dev-tools badge when Next has something to
  // show: a build error, or its security "Insight" for an installed version with an open
  // npm advisory. Under the e2e flag the advisory check is off, so an advisory against
  // the pinned version cannot land a badge in every smoke screenshot, nor stop the first
  // `next dev` start with the upgrade reminder (issue 279). `pnpm dev` keeps both.
  ...(e2e ? { experimental: { agentUpgrade: false } } : {}),
};

export default nextConfig;
