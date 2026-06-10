/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow larger CSV uploads via the API route (USmon exports can hit ~5MB for big catalogs)
  experimental: {
    serverActions: { bodySizeLimit: '10mb' },
  },
};

export default nextConfig;
