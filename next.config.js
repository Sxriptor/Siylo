const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  assetPrefix: process.env.NODE_ENV === "production" ? "./" : undefined,
  outputFileTracingRoot: path.resolve(__dirname),
};

module.exports = nextConfig;
