import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("cloudbuild.yaml", () => {
  it("builds with BuildKit while the Dockerfile relies on $BUILDPLATFORM", () => {
    // The classic builder leaves $BUILDPLATFORM empty and the build fails
    // with `failed to parse platform : ""`, so no scheduled build can ship.
    if (!/\$BUILDPLATFORM/.test(read("Dockerfile"))) return;
    const buildStep = read("cloudbuild.yaml").split(/\n  - name: /).find((step) => /id: Build\b/.test(step));
    expect(buildStep).toBeDefined();
    expect(buildStep).toMatch(/env:\s*\n\s*- DOCKER_BUILDKIT=1/);
  });
});
