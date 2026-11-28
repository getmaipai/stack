/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  // Hosting is not decided yet. Set DOCS_BASE_PATH when the site lives under a sub-path.
  basePath: process.env.DOCS_BASE_PATH || '',
  env: { NEXT_PUBLIC_BASE_PATH: process.env.DOCS_BASE_PATH || '' },
  reactStrictMode: true,
  images: { unoptimized: true },
  agentRules: false,
};

export default config;
