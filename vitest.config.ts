import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * The tests predate the TypeScript sources and import (and vi.mock) them by
 * their old `.js` names. Vite only maps `.js` to `.ts` for TypeScript
 * importers, so point a relative `.js` specifier at the `.ts` file beside it
 * when there is no `.js` file of that name.
 */
const jsToTs: Plugin = {
  name: "js-specifier-to-ts",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
    const candidate = resolve(dirname(importer), `${source.slice(0, -3)}.ts`);
    return existsSync(candidate) ? candidate : null;
  },
};

export default defineConfig({
  plugins: [jsToTs],
});
