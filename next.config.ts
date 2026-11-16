import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Separate build dirs let the simulation run its own server next to `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
