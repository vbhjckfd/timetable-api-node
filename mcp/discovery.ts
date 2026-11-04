import type { Tool } from "@modelcontextprotocol/server";

import pkg from "../package.json" with { type: "json" };
import { MCP_SERVER_INFO } from "./timetableMcpServer.ts";
import type { McpManifest } from "./timetableMcpServer.ts";

/**
 * Discovery documents other than the MCP server card: the A2A agent card, the
 * OpenAI plugin manifest, robots.txt and llms-full.txt. Tool lists in them are
 * built from mcpManifest(), so a tool added, renamed or removed shows up here
 * without a second edit (agent.json kept advertising a removed tool for months
 * when it was a hand-written list).
 */

const trimBase = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

/** Sample questions per tool for the agent card; tools without an entry get none. */
export const TOOL_EXAMPLES: Record<string, string[]> = {
  search_stops: ["Which stop ID is Опера?", "Find the stop called Rynok"],
  get_stops_around_location: ["Find stops near 49.84, 24.03", "Stops within 300 m of my location"],
  get_stop_realtime: ["What buses are arriving at stop 707?", "Next tram at stop 707"],
  find_routes_between: ["How do I get from Опера to the railway station?", "When should I leave to be at Сихів by 9:00?"],
  get_route_static: ["Show me route Т30 stops", "Route А32 timetable"],
  get_route_realtime: ["Where are the Т6 trams right now?", "How often is А32 running now?"],
  get_nearby_vehicles: ["What transport is near 49.84, 24.03?", "Low-floor vehicles around me"],
  get_vehicle_info: ["Where is vehicle 12345 heading?"],
  get_disruptions: ["Is bus А34 on a detour?", "Which routes are affected by road works?"],
};

/** First sentence of a tool description, without the markdown meant for models. */
export function firstSentence(text: string | undefined): string {
  const plain = String(text ?? "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  const match = plain.match(/^.*?[.!?](?=\s|$)/s);
  return (match ? match[0] : plain).trim();
}

const SKILL_TAGS = (tool: Tool): string[] => {
  const tags = ["transit", "lviv"];
  if (/realtime|vehicles|vehicle_info/.test(tool.name)) tags.push("realtime");
  if (/stop/.test(tool.name)) tags.push("stops");
  if (/route/.test(tool.name)) tags.push("routes");
  if (/location|nearby/.test(tool.name)) tags.push("location");
  if (tool.name === "get_disruptions") tags.push("disruptions");
  return tags;
};

/**
 * A2A agent card. The server speaks MCP, not A2A, so the card is a discovery
 * pointer: `url` is the MCP endpoint (a JSON-RPC 2.0 endpoint, so an A2A
 * client gets a JSON-RPC "method not found" rather than an HTML 404), and the
 * description says to connect an MCP client there.
 */
export function buildAgentCard(baseUrl: string, manifest: McpManifest) {
  const base = trimBase(baseUrl);
  return {
    protocolVersion: "0.3.0",
    name: MCP_SERVER_INFO.title,
    description: `${MCP_SERVER_INFO.description} This agent speaks the Model Context Protocol, not A2A: connect an MCP client (Streamable HTTP) to ${base}/mcp.`,
    url: `${base}/mcp`,
    version: pkg.version,
    iconUrl: `${base}/favicon.png`,
    documentationUrl: `${base}/llms-full.txt`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    skills: manifest.tools.map((tool) => ({
      id: tool.name,
      name: tool.title ?? tool.name,
      description: firstSentence(tool.description),
      tags: SKILL_TAGS(tool),
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      ...(TOOL_EXAMPLES[tool.name] ? { examples: TOOL_EXAMPLES[tool.name] } : {}),
    })),
    securitySchemes: {},
    security: [],
    provider: {
      organization: "lad.lviv.ua",
      url: "https://lad.lviv.ua",
    },
    mcpEndpoint: `${base}/mcp`,
    mcpServerCard: `${base}/.well-known/mcp/server-card.json`,
    openApiUrl: `${base}/openapi.yaml`,
  };
}

/** OpenAI plugin manifest, for GPT Actions and frameworks that still read it. */
export function buildAiPluginManifest(baseUrl: string) {
  const base = trimBase(baseUrl);
  return {
    schema_version: "v1",
    name_for_human: MCP_SERVER_INFO.title,
    name_for_model: "lviv_timetable",
    description_for_human:
      "Real-time and static public transport data for Lviv, Ukraine — stops, routes, timetables, trip planning, live vehicle positions. No API key required.",
    description_for_model:
      "Provides real-time arrivals, live vehicle positions, static timetables, route shapes, and stop discovery for public transport in Lviv, Ukraine. Data sourced from municipal GTFS-RT feeds. All endpoints are read-only and require no authentication. Use stop numeric codes (e.g. 707) and route short names (e.g. Т30, А32). " +
      `An MCP server with the same data plus trip planning, stop search by name and announced disruptions is at ${base}/mcp (Streamable HTTP, no auth); prefer it when your client supports MCP.`,
    auth: { type: "none" },
    api: {
      type: "openapi",
      url: `${base}/openapi.yaml`,
    },
    logo_url: `${base}/favicon.png`,
    contact_email: "vbhjckfd@gmail.com",
    legal_info_url: "https://lad.lviv.ua",
  };
}

export function buildRobotsTxt(baseUrl: string): string {
  const base = trimBase(baseUrl);
  return [
    "User-agent: *",
    "Disallow: /private/",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
    "# Non-standard hint for AI agent discovery:",
    `# mcp-server: ${base}/.well-known/mcp/server-card.json`,
    `# llms-txt: ${base}/llms.txt`,
  ].join("\n");
}

interface PropertySchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
}

function renderArguments(inputSchema: Tool["inputSchema"]): string {
  const properties = Object.entries((inputSchema.properties ?? {}) as Record<string, PropertySchema>);
  if (!properties.length) return "No arguments.\n";
  const required = new Set(inputSchema.required ?? []);
  return properties
    .map(([name, schema]) => {
      const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type ?? "any";
      return `- \`${name}\` (${type}${required.has(name) ? ", required" : ""}): ${schema.description ?? ""}`.trimEnd();
    })
    .join("\n") + "\n";
}

/**
 * The long llms.txt: setup for common clients, then every tool, prompt and
 * resource as the server lists them, so an agent can plan calls before it
 * connects.
 */
export function buildLlmsFullTxt(baseUrl: string, manifest: McpManifest): string {
  const base = trimBase(baseUrl);
  const endpoint = `${base}/mcp`;
  const tools = manifest.tools
    .map((tool) => `### ${tool.name}${tool.title ? ` — ${tool.title}` : ""}\n\n${tool.description ?? ""}\n\nArguments:\n\n${renderArguments(tool.inputSchema)}`)
    .join("\n");
  const prompts = manifest.prompts
    .map((p) => {
      const args = (p.arguments ?? []).map((a) => `\`${a.name}\`${a.required ? "" : "?"}`).join(", ");
      return `- \`${p.name}\`${args ? ` (${args})` : ""}: ${p.description ?? ""}`;
    })
    .join("\n");
  const resources = [
    ...manifest.resources.map((r) => `- \`${r.uri}\`: ${r.description ?? r.title ?? ""}`),
    ...manifest.resourceTemplates.map((r) => `- \`${r.uriTemplate}\` (template): ${r.description ?? r.title ?? ""}`),
  ].join("\n");

  return `# ${MCP_SERVER_INFO.title} — full reference

> ${MCP_SERVER_INFO.description}

Short version: ${base}/llms.txt. Server card: ${base}/.well-known/mcp/server-card.json. REST API: ${base}/openapi.yaml. Rider website: https://lad.lviv.ua (its own llms.txt: https://lad.lviv.ua/llms.txt).

## Connect

MCP endpoint: \`${endpoint}\` — Streamable HTTP, stateless, no authentication. Server version ${pkg.version}.

- Claude Code: \`claude mcp add --transport http lviv-timetable ${endpoint}\`
- Claude Desktop / claude.ai: Settings → Connectors → Add custom connector → \`${endpoint}\`
- ChatGPT (developer mode): create a connector with MCP server URL \`${endpoint}\` and no authentication
- Cursor / VS Code / any client taking JSON config: \`{"mcpServers": {"lad-lviv": {"url": "${endpoint}"}}}\`
- stdio-only clients: \`npx timetable-api-node\` (a proxy to the live server; \`MCP_URL\` overrides the endpoint)

## Server instructions

${manifest.instructions}

## Tools

${tools}
## Prompts

${prompts}

## Resources

${resources}
`;
}
