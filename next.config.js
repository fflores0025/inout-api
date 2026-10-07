/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin',  value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, x-requested-with, x-terminal-key, idempotency-key' },
          { key: 'Access-Control-Max-Age',       value: '86400' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
