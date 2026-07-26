import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `backlex` is consumed by source inside this monorepo (the workspace package
  // points `main` at `./src/index.ts`), so Next has to compile it rather than
  // treat it as a prebuilt dependency. Outside the monorepo you'd install the
  // published package and drop this line.
  transpilePackages: ["backlex"],
};

export default nextConfig;
