# Integration Guide

Lviv Public Transport API — integration recipes for common AI agent frameworks.

Base URL: `https://api.lad.lviv.ua`  
MCP endpoint: `https://api.lad.lviv.ua/mcp`  
OpenAPI spec: `https://api.lad.lviv.ua/openapi.yaml`  
No API key or authentication required.

---

## MCP (Model Context Protocol)

### Claude Desktop / Claude Code

Add to `~/.claude/claude_desktop_config.json` (or `claude.ai/code` MCP settings):

```json
{
  "mcpServers": {
    "lviv-timetable": {
      "url": "https://api.lad.lviv.ua/mcp"
    }
  }
}
```

### Cursor / Windsurf / any stdio MCP client

```bash
npx timetable-api-node
```

Or pin the config:

```json
{
  "mcpServers": {
    "lviv-timetable": {
      "command": "npx",
      "args": ["-y", "timetable-api-node"]
    }
  }
}
```

The `npx` entry is a zero-dependency stdio proxy — it forwards requests to the live API with no local setup.

### MCP Inspector (testing)

```bash
npx @modelcontextprotocol/inspector \
  --transport streamable-http \
  --url https://api.lad.lviv.ua/mcp
```

---

## LangChain (Python)

```python
from langchain_community.agent_toolkits.openapi.toolkit import RequestsToolkit
from langchain_community.utilities.requests import TextRequestsWrapper
from langchain_community.tools.json.tool import JsonSpec
import httpx, yaml

# Load spec
spec_text = httpx.get("https://api.lad.lviv.ua/openapi.yaml").text
spec = JsonSpec(dict_=yaml.safe_load(spec_text), max_value_length=4000)

toolkit = RequestsToolkit(
    requests_wrapper=TextRequestsWrapper(headers={}),
    allow_dangerous_requests=True,
)
tools = toolkit.get_tools()
```

Or use the `NLAToolkit` for natural-language-first access:

```python
from langchain_community.agent_toolkits.openapi.toolkit import OpenAPIToolkit
from langchain_community.utilities.requests import TextRequestsWrapper
from langchain.agents import AgentType, initialize_agent

toolkit = OpenAPIToolkit.from_llm(
    llm=your_llm,
    json_spec=spec,
    requests_wrapper=TextRequestsWrapper(headers={}),
    allow_dangerous_requests=True,
)
agent = initialize_agent(
    toolkit.get_tools(),
    your_llm,
    agent=AgentType.STRUCTURED_CHAT_ZERO_SHOT_REACT_DESCRIPTION,
    verbose=True,
)
agent.run("What buses are arriving at stop 707 in Lviv?")
```

### LangChain (JS/TS)

```typescript
import { OpenApiToolkit } from "langchain/agents/toolkits";
import { ChatOpenAI } from "@langchain/openai"; // or any LLM

const toolkit = await OpenApiToolkit.fromLLM(yourLLM, {
  openApiSpecUrl: "https://api.lad.lviv.ua/openapi.yaml",
});
const tools = toolkit.getTools();
```

---

## LlamaIndex (Python)

```python
from llama_index.tools.openapi import OpenAPIToolSpec
from llama_index.agent.openai import OpenAIAgent

tool_spec = OpenAPIToolSpec(url="https://api.lad.lviv.ua/openapi.yaml")
tools = tool_spec.to_tool_list()

agent = OpenAIAgent.from_tools(tools, verbose=True)
agent.chat("Find stops near latitude 49.84, longitude 24.03")
```

---

## OpenAI GPT Actions / Assistants API

1. Create a new GPT (or Assistant).
2. Under **Actions**, click **Import from URL** and paste:  
   `https://api.lad.lviv.ua/openapi.yaml`
3. Set authentication to **None**.
4. Save and test with: "What trams are running on route T30 right now?"

---

## Vercel AI SDK (JS/TS)

```typescript
import { openapi } from "@ai-sdk/openapi";
import { generateText } from "ai";

const tools = await openapi("https://api.lad.lviv.ua/openapi.yaml");

const { text } = await generateText({
  model: yourModel,
  tools,
  prompt: "When is the next bus at stop 707?",
});
```

---

## n8n

1. Add an **HTTP Request** node.
2. Set method to `GET`, URL to `https://api.lad.lviv.ua/stops/707/timetable`.
3. Connect to an **AI Agent** node (Tools Agent) and pass the response to your LLM.

Or use the built-in **OpenAPI** credential type with spec URL `https://api.lad.lviv.ua/openapi.yaml`.

---

## Direct REST (fetch / curl)

```bash
# Live arrivals at stop 707
curl https://api.lad.lviv.ua/stops/707/timetable

# Stops within 300m of a coordinate
curl "https://api.lad.lviv.ua/closest?latitude=49.8397&longitude=24.0297&radius=300"

# Live vehicles on route T30
curl https://api.lad.lviv.ua/routes/dynamic/T30

# Route static data (stops + polylines)
curl https://api.lad.lviv.ua/routes/static/32A
```

Full endpoint reference: [`/openapi.yaml`](https://api.lad.lviv.ua/openapi.yaml) or [`/llms.txt`](https://api.lad.lviv.ua/llms.txt).
