/**
 * Vite configuration for the Bitty plugin store.
 *
 * The store is a framework-free TypeScript app: small custom elements render
 * the committed `generated/registry.json` index. The `bitty-registry` plugin
 * serves that file during development and emits it beside `index.html` at
 * build time, so the deployed site fetches it as a plain static asset and no
 * duplicate of the index is ever committed under `app/`.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const registrySource = resolve(
  import.meta.dirname,
  "..",
  "generated",
  "registry.json",
);

async function readRegistry(): Promise<Buffer> {
  try {
    return await readFile(registrySource);
  } catch {
    throw new Error(
      `${registrySource} is missing; run \`just registry-generate\` before building the store`,
    );
  }
}

function registryPlugin(): Plugin {
  return {
    name: "bitty-registry",
    configureServer(server) {
      server.middlewares.use("/registry.json", (_request, response) => {
        void readRegistry()
          .then((body) => {
            response.setHeader(
              "Content-Type",
              "application/json; charset=utf-8",
            );
            response.setHeader("Cache-Control", "no-store");
            response.end(body);
          })
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(
              error instanceof Error ? error.message : String(error),
            );
          });
      });
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "registry.json",
        source: await readRegistry(),
      });
    },
  };
}

export default defineConfig({
  plugins: [registryPlugin()],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
