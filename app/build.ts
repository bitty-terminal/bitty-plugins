/**
 * Build the static store into app/dist.
 *
 * Steps: bundle src/main.ts for the browser, copy public/ assets, copy the
 * generated registry index, and rewrite the shell asset URLs to the built
 * files. The build fails loudly when generated/registry.json is missing so a
 * deploy can never ship a stale or empty directory.
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const appDir = import.meta.dir;
const distDir = join(appDir, "dist");
const registryFile = join(appDir, "..", "generated", "registry.json");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(registryFile))) {
  console.error(
    "error: generated/registry.json is missing; run `just registry-generate` first",
  );
  process.exit(1);
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(appDir, "src", "main.ts")],
  outdir: distDir,
  target: "browser",
  minify: true,
  naming: "[name].[ext]",
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await cp(join(appDir, "public"), distDir, { recursive: true });
await cp(registryFile, join(distDir, "registry.json"));

const shell = await readFile(join(appDir, "index.html"), "utf8");
const builtShell = shell
  .replaceAll('href="/src/styles.css"', 'href="./styles.css"')
  .replaceAll('src="/src/main.ts"', 'src="./main.js"');
await writeFile(join(distDir, "index.html"), builtShell);

await cp(join(appDir, "src", "styles.css"), join(distDir, "styles.css"));

console.log("built app/dist (index.html, main.js, styles.css, registry.json)");
