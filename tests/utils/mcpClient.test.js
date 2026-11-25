import { describe, it, expect } from "vitest";
import { classifyMcpClient } from "../../utils/mcpClient.ts";

describe("classifyMcpClient", () => {
  it.each([
    ["lad.lviv.ua chat", false, "website chat"],
    ["node", true, "website chat"],
    ["timetable-telegram", false, "telegram bot"],
    ["Claude-User", false, "claude"],
    ["claude-code/2.1.330 (cli)", false, "claude"],
    ["openai-mcp/1.0.0", false, "chatgpt"],
    ["ChatGPT-User/1.0", false, "chatgpt"],
    ["Cursor/1.2", false, "cursor"],
    ["mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)", false, "probe"],
    ["KitScout-LiveCheck/0.1", false, "probe"],
    ["python-httpx/0.28.1", false, "script"],
    ["node", false, "script"],
    ["Go-http-client/2.0", false, "script"],
    ["Mozilla/5.0", false, "other"],
    [undefined, false, "other"],
  ])("%s (internal=%s) is %s", (ua, internal, expected) => {
    expect(classifyMcpClient(ua, internal)).toBe(expected);
  });

  it("falls back to clientInfo.name when the user agent says nothing", () => {
    expect(classifyMcpClient("node", false, "claude-ai")).toBe("claude");
    expect(classifyMcpClient("undici", false, "openai-mcp")).toBe("chatgpt");
  });
});
