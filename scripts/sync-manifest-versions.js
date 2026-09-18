// Copies package.json's version into server.json and openapi.yaml. Runs as
// npm's `version` hook, so `npm version` puts all three in the release commit
// and the publish workflow never has to push a sync commit to protected master.
// Rewrites only the version line, leaving the rest of each file's formatting.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const replaceOnce = (file, pattern, replacement) => {
  const before = readFileSync(file, "utf8");
  if (!pattern.test(before)) throw new Error(`${file}: no version line found`);
  writeFileSync(file, before.replace(pattern, replacement));
};

replaceOnce("server.json", /^(  "version": )"[^"]*"/m, `$1"${version}"`);
replaceOnce("openapi.yaml", /^(  version: ).*$/m, `$1${version}`);
