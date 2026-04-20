# Timetable API Node

Express-based API for Lviv transport timetable data with a read-only MCP endpoint.

## Requirements

- Node.js 22 (see `.nvmrc`)

## Run locally

```bash
nvm use
make start
```

## Test

```bash
nvm use && make test
```

## MCP Server

This service exposes a public read-only MCP endpoint over Streamable HTTP.

- MCP endpoint: `/mcp`
- Server card: `/.well-known/mcp/server-card.json`
- Discovery hint: `/robots.txt` (non-standard comment hint)

### Exposed tools

- `get_stop_by_code`
- `get_stop_timetable`
- `get_closest_stops`
- `get_route_static`
- `get_route_dynamic`

### Security model

- Public read-only (no authentication).
- No mutating tools are exposed.
- `robots.txt` is only a best-effort discovery hint and not a protocol contract.
