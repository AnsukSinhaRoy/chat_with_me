/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Optional: proxy same-origin /api/* from the Next.js frontend to your backend.
   *
   * On Vercel, set BACKEND_URL to something like:
   *   https://your-backend-project.vercel.app
   *
   * Then the frontend can call `/api/chat` without CORS issues.
   */
  async rewrites() {
    const backend = process.env.BACKEND_URL;
    if (!backend) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${backend}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
