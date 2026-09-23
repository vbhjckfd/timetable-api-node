import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildMcpServerCard, createTimetableMcpServer } from "./timetableMcpServer.js";

/**
 * GET /mcp is also where a Streamable HTTP client asks for an SSE stream, and
 * that client must keep getting 405 — a 200 with HTML would be parsed as a
 * broken stream. Browsers are the only callers that ask for text/html and not
 * for text/event-stream, so that is the whole test.
 */
export function wantsHtmlDocs(acceptHeader) {
  const accept = String(acceptHeader ?? "").toLowerCase();
  return accept.includes("text/html") && !accept.includes("text/event-stream");
}

/**
 * The tool and prompt lists come from a real tools/list and prompts/list
 * against the server, so the page shows exactly the schemas clients are
 * given and cannot drift from registerTools(). They only change with a code
 * push, so the listing is taken once per process.
 */
let catalogPromise;

async function loadCatalog() {
  const server = createTimetableMcpServer();
  const client = new Client({ name: "docs-page", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const [{ tools }, { prompts }] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
    ]);
    return { tools, prompts };
  } finally {
    await client.close();
    await server.close();
  }
}

function getCatalog() {
  catalogPromise ??= loadCatalog().catch((error) => {
    catalogPromise = undefined;
    throw error;
  });
  return catalogPromise;
}

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Tool descriptions carry `code` and **bold** for the model; keep them readable here. */
const inlineMarkdown = (value) =>
  escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

function describeType(schema = {}) {
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type ?? "any";
  const bounds = [];
  if (schema.minimum !== undefined) bounds.push(`≥ ${schema.minimum}`);
  if (schema.maximum !== undefined) bounds.push(`≤ ${schema.maximum}`);
  if (schema.minLength !== undefined) bounds.push(`min length ${schema.minLength}`);
  if (schema.default !== undefined) bounds.push(`default ${JSON.stringify(schema.default)}`);
  return bounds.length ? `${type}, ${bounds.join(", ")}` : type;
}

function renderParams(inputSchema = {}) {
  const properties = Object.entries(inputSchema.properties ?? {});
  if (!properties.length) return `<p class="muted">No arguments.</p>`;
  const required = new Set(inputSchema.required ?? []);
  const rows = properties
    .map(
      ([name, schema]) => `
          <tr>
            <td><code>${escapeHtml(name)}</code>${required.has(name) ? "" : ' <span class="muted">optional</span>'}</td>
            <td><code>${escapeHtml(describeType(schema))}</code></td>
            <td>${inlineMarkdown(schema.description)}</td>
          </tr>`,
    )
    .join("");
  return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Argument</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>${rows}
          </tbody>
        </table>
      </div>`;
}

function renderTool(tool) {
  return `
    <section class="tool" id="${escapeHtml(tool.name)}">
      <h3><code>${escapeHtml(tool.name)}</code>${tool.title ? ` <span class="muted">${escapeHtml(tool.title)}</span>` : ""}</h3>
      <p>${inlineMarkdown(tool.description)}</p>${renderParams(tool.inputSchema)}
    </section>`;
}

function renderPrompt(prompt) {
  const args = (prompt.arguments ?? [])
    .map((arg) => `<code>${escapeHtml(arg.name)}</code>${arg.required ? "" : " (optional)"}`)
    .join(", ");
  return `
      <li><code>${escapeHtml(prompt.name)}</code> — ${inlineMarkdown(prompt.description)}${args ? ` <span class="muted">Arguments: ${args}</span>` : ""}</li>`;
}

export async function renderMcpDocsPage(baseUrl) {
  const card = buildMcpServerCard(baseUrl);
  const { tools, prompts } = await getCatalog();
  const endpoint = card.remotes[0].url;
  const base = baseUrl.replace(/\/+$/, "");

  const desktopConfig = JSON.stringify(
    { mcpServers: { "lviv-timetable": { url: endpoint } } },
    null,
    2,
  );
  const stdioConfig = JSON.stringify(
    { mcpServers: { "lviv-timetable": { command: "npx", args: ["-y", "timetable-api-node"] } } },
    null,
    2,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(card.title)}</title>
<meta name="description" content="${escapeHtml(card.description)}">
<link rel="icon" href="${escapeHtml(card.iconUrl)}" type="image/svg+xml">
<style>
  :root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b6860; --line: #e2dfd7; --code: #f0ede6; --accent: #b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --fg: #ebe9e4; --muted: #9a978f; --line: #2f2e2b; --code: #232220; --accent: #f28b82; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 52rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
  header { display: flex; gap: 1rem; align-items: center; }
  header img { width: 3rem; height: 3rem; }
  h1 { font-size: 1.75rem; margin: 0; }
  h2 { font-size: 1.25rem; margin: 2.5rem 0 0.75rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1.05rem; margin: 0 0 0.4rem; }
  a { color: var(--accent); }
  code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 0.1em 0.3em; border-radius: 4px; }
  pre { background: var(--code); padding: 0.9rem 1rem; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  .muted { color: var(--muted); font-weight: normal; }
  .endpoint { font-size: 1.05rem; }
  .tool { padding: 1.1rem 0; border-bottom: 1px solid var(--line); }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.93rem; }
  th, td { text-align: left; vertical-align: top; padding: 0.45rem 0.6rem; border-top: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
  ul { padding-left: 1.2rem; }
  li { margin: 0.35rem 0; }
</style>
</head>
<body>
<main>
  <header>
    <img src="${escapeHtml(card.iconUrl)}" alt="">
    <div>
      <h1>${escapeHtml(card.title)}</h1>
      <div class="muted">Model Context Protocol server · v${escapeHtml(card.version)}</div>
    </div>
  </header>

  <p>${escapeHtml(card.description)}</p>
  <p class="endpoint">Endpoint: <code>${escapeHtml(endpoint)}</code> <span class="muted">(Streamable HTTP, POST only, stateless)</span></p>
  <p class="muted">This page is for people. MCP clients talk to the same URL with JSON-RPC over POST.</p>

  <h2>Connect</h2>
  <h3>Claude Code</h3>
  <pre><code>claude mcp add --transport http lviv-timetable ${escapeHtml(endpoint)}</code></pre>
  <h3>Claude Desktop and claude.ai</h3>
  <p>Settings → Connectors → Add custom connector, then paste <code>${escapeHtml(endpoint)}</code>. No authentication.</p>
  <h3>Cursor and other clients with remote MCP support</h3>
  <pre><code>${escapeHtml(desktopConfig)}</code></pre>
  <h3>stdio-only clients, including Claude Desktop's config file</h3>
  <pre><code>${escapeHtml(stdioConfig)}</code></pre>
  <h3>MCP Inspector</h3>
  <pre><code>npx @modelcontextprotocol/inspector --transport streamable-http --url ${escapeHtml(endpoint)}</code></pre>

  <h2>Tools</h2>
  <p>All ${tools.length} tools are read-only. Each result is JSON with <code>view</code>, <code>data</code> (the raw payload) and <code>ui_blocks</code> (map and arrival-list rendering hints). Stop IDs are the numeric codes printed on stop signs; to turn an address into a stop ID, call <code>get_stops_around_location</code> first.</p>
  ${tools.map(renderTool).join("")}

  <h2>Prompts</h2>
  <ul>${prompts.map(renderPrompt).join("")}
  </ul>

  <h2>More</h2>
  <ul>
    <li><a href="${escapeHtml(`${base}/.well-known/mcp/server-card.json`)}">Server card</a> (machine-readable metadata)</li>
    <li><a href="${escapeHtml(`${base}/openapi.yaml`)}">OpenAPI spec</a> for the REST API behind these tools</li>
    <li><a href="${escapeHtml(card.registryUrl)}">MCP Registry entry</a></li>
    <li><a href="https://github.com/vbhjckfd/timetable-api-node">Source on GitHub</a></li>
    <li><a href="${escapeHtml(card.websiteUrl)}">${escapeHtml(card.websiteUrl.replace(/^https?:\/\//, ""))}</a>, the rider-facing site</li>
  </ul>
</main>
</body>
</html>
`;
}
