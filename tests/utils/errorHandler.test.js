import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";

import errorHandler from "../../utils/errorHandler.js";

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "1kb" }));

  app.post("/mcp", (req, res) => res.json({ ok: true }));
  app.post("/other", (req, res) => res.json({ ok: true }));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });

  app.use(errorHandler);

  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const postJson = (path, body) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

describe("errorHandler", () => {
  it("answers malformed JSON on /mcp with a 400 JSON-RPC parse error", async () => {
    const response = await postJson("/mcp", '{"jsonrpc":');

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.jsonrpc).toBe("2.0");
    expect(payload.error.code).toBe(-32700);
    expect(payload.id).toBe(null);
  });

  it("answers an oversized body on /mcp with 413", async () => {
    const response = await postJson("/mcp", JSON.stringify({ pad: "x".repeat(2048) }));

    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload.error.code).toBe(-32600);
  });

  it("keeps the plain error shape off /mcp", async () => {
    const response = await postJson("/other", '{"jsonrpc":');

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.jsonrpc).toBeUndefined();
    expect(typeof payload.error).toBe("string");
  });

  it("still reports a real fault as 500 without leaking the message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await fetch(`${baseUrl}/boom`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
