#!/usr/bin/env node
// Stdio-to-HTTP proxy — bridges local MCP clients (Claude Desktop, Cursor, etc.)
// to the live Lviv Public Transport MCP server without requiring a local database.
import "dotenv/config";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const upstreamUrl = new URL(
  process.env.MCP_URL || "https://api.lad.lviv.ua/mcp",
);

async function main() {
  const upstream = new Client(
    { name: "lviv-timetable-stdio-proxy", version: "1.0.0" },
    { capabilities: {} },
  );

  await upstream.connect(new StreamableHTTPClientTransport(upstreamUrl));

  const [{ tools }, { resources }, { prompts }] = await Promise.all([
    upstream.listTools(),
    upstream.listResources(),
    upstream.listPrompts(),
  ]);

  const server = new Server(
    { name: "com.lad.lviv/timetable-api", version: "1.0.0" },
    {
      capabilities: {
        ...(tools.length && { tools: {} }),
        ...(resources.length && { resources: {} }),
        ...(prompts.length && { prompts: {} }),
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));

  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    upstream.callTool(req.params),
  );
  server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
    upstream.readResource(req.params),
  );
  server.setRequestHandler(GetPromptRequestSchema, async (req) =>
    upstream.getPrompt(req.params),
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
