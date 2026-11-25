/**
 * Which kind of client a POST /mcp came from, for the `mcpClient` attribute on
 * its New Relic transaction (`FROM Transaction SELECT count(*) FACET mcpClient`).
 *
 * Each request is stateless, so only `initialize` carries clientInfo; the user
 * agent is on every request and decides first. Our own callers name themselves:
 * the lad.lviv.ua chat sends "lad.lviv.ua chat" and the internal key, the bot
 * "timetable-telegram". Most other traffic is registry probes and scripts.
 */
const KINDS: [label: string, pattern: RegExp][] = [
  ["website chat", /lad\.lviv\.ua/i],
  ["telegram bot", /telegram/i],
  ["claude", /claude|anthropic/i],
  ["chatgpt", /openai|chatgpt/i],
  ["cursor", /cursor/i],
  ["probe", /bot\b|probe|crawl|check|index|monitor|collector|scout|research|registry|liveness|observ|survey|census|https?:\/\//i],
  ["script", /^(node|undici|python|go-http|curl|axios|okhttp|java|ruby|deno|bun)/i],
];

export function classifyMcpClient(userAgent = "", internal = false, clientName = ""): string {
  if (internal) return "website chat";
  const fromAgent = KINDS.find(([, pattern]) => pattern.test(userAgent))?.[0];
  if (fromAgent && fromAgent !== "script") return fromAgent;
  return KINDS.find(([, pattern]) => pattern.test(clientName))?.[0] ?? fromAgent ?? "other";
}
