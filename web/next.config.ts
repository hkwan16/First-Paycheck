import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typedRoutes: true,
  cacheComponents: true,
  partialPrefetching: true,
  // The dev indicator would otherwise land in the Playwright screenshots,
  // which run against `next dev` so that /dev/kit is reachable.
  devIndicators: false,
};

export default nextConfig;
