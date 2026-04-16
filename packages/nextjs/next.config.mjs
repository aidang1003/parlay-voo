/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@parlaycity/shared"],
  experimental: {
    serverComponentsExternalPackages: ["@ai-sdk/anthropic"],
  },
  webpack: (config, { dev }) => {
    // Resolve .js imports in transpiled workspace packages (TS sources with .js extensions)
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    // MetaMask SDK (pulled in by @wagmi/connectors) imports a React Native-only
    // module. Stub it out in the browser build so webpack stops failing.
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      "@react-native-async-storage/async-storage": false,
    };
    if (dev) {
      config.watchOptions = { ...config.watchOptions, followSymlinks: true };
      config.snapshot = { ...config.snapshot, managedPaths: [] };
    }
    return config;
  },
};

export default nextConfig;
