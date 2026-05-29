const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  turbopack: {
    root: path.join(__dirname),
  },
  experimental: {
    // Disabling the separate webpack build worker avoids intermittent CI/Vercel hangs
    // seen with this small static app on serverless CI builds.
    webpackBuildWorker: false,
  },
};

module.exports = nextConfig;
