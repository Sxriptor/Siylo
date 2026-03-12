const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname),
};

module.exports = nextConfig;
