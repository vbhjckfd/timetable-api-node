#!/usr/bin/env node
// Stdio-to-HTTP proxy — bridges local MCP clients (Claude Desktop, Cursor, etc.)
// to the live Lviv Public Transport MCP server without requiring a local database.
import "dotenv/config";

import pkg from "../package.json" with { type: "json" };
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";
import type { Implementation } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const upstreamUrl = new URL(
  process.env.MCP_URL || "https://api.lad.lviv.ua/mcp",
);

/** Lists only change with an upstream deploy; mirrors the upstream's own hints. */
const STATIC_CACHE_HINT = { ttlMs: 60 * 60 * 1000, cacheScope: "public" } as const;

async function main() {
  const upstream = new Client(
    { name: "lviv-timetable-stdio-proxy", version: pkg.version },
    // Speak 2026-07-28 to the upstream when it offers it, else fall back to 2025.
    { capabilities: {}, versionNegotiation: { mode: "auto" } },
  );

  await upstream.connect(new StreamableHTTPClientTransport(upstreamUrl));

  const [{ tools }, { resources }, { resourceTemplates }, { prompts }] = await Promise.all([
    upstream.listTools(),
    upstream.listResources(),
    upstream.listResourceTemplates(),
    upstream.listPrompts(),
  ]);

  // Pass the upstream identity and instructions through: the instructions
  // carry the tool-selection guidance, and without them a stdio client gets
  // the bare tool list only.
  const upstreamInfo: Partial<Implementation> = upstream.getServerVersion() ?? {};
  const upstreamCapabilities = upstream.getServerCapabilities() ?? {};
  const instructions = upstream.getInstructions();

  // serveStdio picks the era from the client's opening message (a 2025
  // `initialize` or a 2026-07-28 `server/discover` / enveloped request) and
  // pins one instance from this factory to the connection.
  const createProxyServer = () => {
    const server = new Server(
      {
        ...upstreamInfo,
        name: upstreamInfo.name ?? "io.github.vbhjckfd/timetable-api-node",
        version: pkg.version,
      },
      {
        capabilities: {
          ...(tools.length && { tools: {} }),
          ...(resources.length || resourceTemplates.length ? { resources: {} } : {}),
          ...(prompts.length && { prompts: {} }),
          ...(upstreamCapabilities.completions && { completions: {} }),
        },
        instructions,
        cacheHints: {
          "server/discover": STATIC_CACHE_HINT,
          "tools/list": STATIC_CACHE_HINT,
          "prompts/list": STATIC_CACHE_HINT,
          "resources/list": STATIC_CACHE_HINT,
          "resources/templates/list": STATIC_CACHE_HINT,
          "resources/read": STATIC_CACHE_HINT,
        },
      },
    );

    server.setRequestHandler("tools/list", async () => ({ tools }));
    server.setRequestHandler("resources/list", async () => ({ resources }));
    server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates }));
    server.setRequestHandler("prompts/list", async () => ({ prompts }));

    server.setRequestHandler("tools/call", async (req) => upstream.callTool(req.params));
    server.setRequestHandler("resources/read", async (req) => upstream.readResource(req.params));
    server.setRequestHandler("prompts/get", async (req) => upstream.getPrompt(req.params));
    if (upstreamCapabilities.completions) {
      server.setRequestHandler("completion/complete", async (req) => upstream.complete(req.params));
    }
    return server;
  };

  serveStdio(createProxyServer, {
    onerror: (error) => process.stderr.write(`Error: ${error.message}\n`),
  });
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
});
