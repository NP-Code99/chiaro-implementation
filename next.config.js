/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:3000', 'localhost:3001']
    },
    serverComponentsExternalPackages: [
      'playwright',
      'playwright-extra',
      'playwright-core',
      'puppeteer-extra-plugin-stealth',
      'puppeteer-extra-plugin',
      'puppeteer-extra',
      'clone-deep',
      'merge-deep',
      'googleapis',
      'google-auth-library',
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Prevent webpack from trying to bundle Node-only browser automation packages
      const browserPkgs = [
        'playwright',
        'playwright-extra',
        'playwright-core',
        'puppeteer-extra-plugin-stealth',
        'puppeteer-extra-plugin',
        'puppeteer-extra',
        'clone-deep',
        'merge-deep',
        'scrapfly-sdk',
        'googleapis',
        'google-auth-library',
        'gaxios',
        'gcp-metadata',
        'google-logging-utils',
      ]
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        ({ request }, callback) => {
          if (browserPkgs.some(pkg => request === pkg || request.startsWith(pkg + '/'))) {
            return callback(null, 'commonjs ' + request)
          }
          callback()
        },
      ]
    }
    return config
  },
}

module.exports = nextConfig
