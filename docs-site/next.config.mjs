import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const basePath = process.env.GITHUB_ACTIONS === 'true' ? '/opencode-cursor' : '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  basePath,
  images: { unoptimized: true },
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default withMDX(config);
