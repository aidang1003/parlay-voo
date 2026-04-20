/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@parlayvoo/shared"],
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
    // pino-pretty is a dev-only optional dep of pino (via WalletConnect) —
    // aliasing to false silences the "Module not found" warning in prod builds.
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      "@react-native-async-storage/async-storage": false,
    };
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "pino-pretty": false,
    };
    if (dev) {
      config.watchOptions = { ...config.watchOptions, followSymlinks: true };
      config.snapshot = { ...config.snapshot, managedPaths: [] };
    }
    return config;
  },
};

export default nextConfig;
