# stop-overrides Worker

Stores the per-stop route overrides that the `/stops` listing applies to its
route column and to its SVG/PDF links.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/stop-overrides` | public | the whole map, `Cache-Control: no-store` |
| `PUT` | `/stop-overrides/admin/:code` | Cloudflare Access | replace one stop's entry |

Body and stored shape:

```json
{ "62": { "add": ["Т03"], "remove": ["А57"] } }
```

An entry whose `add` and `remove` are both empty is deleted rather than stored,
so a stop back on its upstream route list leaves no trace.

## Why one KV key

The whole map lives under a single key, `overrides`. The listing renders ~1000
rows and reads this once per page load — a key per stop would be a thousand
reads for the same few kilobytes. KV is eventually consistent, so a write can
take up to ~60s to reach every edge; for an override list edited by hand that
is not worth trading for D1.

Writes are read-modify-write on that one key, which would lose an update if two
people saved different stops in the same instant. One editor, so it has not been
worth a lock.

## Setup

```bash
npx wrangler kv namespace create STOP_OVERRIDES
```

Put the returned id into `wrangler.toml`.

Then create the Access application:

- **Application domain**: `api.lad.lviv.ua`, path `stop-overrides/admin`
- Policy: whoever should be able to edit
- Copy the application's **Audience (AUD) tag** into `ACCESS_AUD`, and your team
  domain (`<team>.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`

The Worker verifies the Access JWT itself against
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` — signature, `aud`,
`iss` and `exp` — rather than trusting that the request came through the proxy.

```bash
npx wrangler deploy
```

## Cache rule

`api.lad.lviv.ua` is covered by a "Cache everything" rule, and cache rules do
not stop at the first match — the **last** matching rule wins. Add one and place
it **last**:

```
Expression:  (http.host eq "api.lad.lviv.ua" and starts_with(http.request.uri.path, "/stop-overrides"))
Action:      Bypass cache
```

Without it the override map is served from cache and edits appear to do nothing
for up to the zone's edge TTL.
