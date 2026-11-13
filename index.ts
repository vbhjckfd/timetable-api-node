import "dotenv/config";

import path from "path";
const __dirname = import.meta.dirname;
const PORT = process.env.PORT || 8080;

import { openDb } from "gtfs";
import { readFile } from "fs/promises";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import express from "express";
import type { Request, Response } from "express";
import localDb from "./connections/timetableSqliteDb.ts";

import notFoundAction from "./actions/notFoundAction.ts";
import validateStopCode from "./utils/stopCodeMiddleware.ts";
import { isInternalCaller } from "./utils/internalCaller.ts";

import getClosestStopsAction from "./actions/getClosestStopsAction.ts";
import getSingleStopAction from "./actions/getSingleStopAction.ts";
import getStopTimetableAction from "./actions/getStopTimetableAction.ts";
import getStopStaticDataAction from "./actions/getStopStaticDataAction.ts";
import getAllStopsAction from "./actions/getAllStopsAction.ts";
import routeInfoDynamicAction from "./actions/routeDynamicInfoAction.ts";
import routeInfoStaticAction from "./actions/routeStaticInfoAction.ts";
import vehicleInfoAction from "./actions/vehicleInfoAction.ts";
import vehicleByPlateAction from "./actions/vehicleByPlateAction.ts";
import closestTransportAction from "./actions/closestTransportAction.ts";
import getAllRoutesAction from "./actions/getAllRoutesAction.ts";
import sitemapAction from "./actions/sitemapAction.ts";
import getDisruptionsAction from "./actions/getDisruptionsAction.ts";
import {
  buildMcpServerCard,
  handleMcpPostRequest,
  mcpManifest,
} from "./mcp/timetableMcpServer.ts";
import {
  buildAgentCard,
  buildAiPluginManifest,
  buildLlmsFullTxt,
  buildRobotsTxt,
} from "./mcp/discovery.ts";
import { renderMcpDocsPage, wantsHtmlDocs } from "./mcp/docsPage.ts";
import healthAction from "./actions/healthAction.ts";
import errorHandler from "./utils/errorHandler.ts";

const app = express();

app.set("trust proxy", true);

/**
 * Cache headers for responses baked into the image: docs, manifests, icons.
 * A GTFS data refresh never changes these, so they are tagged "long" and the
 * daily refresh build leaves them alone; only code-push builds purge the tag
 * (see the DropCache step in cloudbuild.yaml). GTFS-derived responses use
 * "short" instead and are purged by every build.
 */
const setStaticAssetCache = (res: Response, maxAgeSeconds = 3600 * 24) =>
  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${maxAgeSeconds}`)
    .set("Cache-Tag", "long");

app.use(cors());

// RFC 8288 Link headers for agent discovery. service-desc is the API
// description (RFC 8631), so it names the OpenAPI document; the MCP card gets
// the same rel the website's <link> tag uses. There is no
// oauth-protected-resource link: nothing here needs auth, and advertising
// protected-resource metadata invites a client to start an OAuth flow that
// has no authorization server to go to.
app.use((req, res, next) => {
  const baseUrl = `${req.protocol}://${req.host}`;
  res.set(
    "Link",
    [
      `<${baseUrl}/openapi.yaml>; rel="service-desc"; type="application/yaml"`,
      `<${baseUrl}/.well-known/mcp/server-card.json>; rel="mcp-server-card"; type="application/json"`,
      `<${baseUrl}/mcp>; rel="mcp-server"`,
      `<${baseUrl}/llms.txt>; rel="describedby"; type="text/plain"`,
    ].join(", "),
  );
  res.set("X-MCP-Server", `${baseUrl}/.well-known/mcp/server-card.json`);
  next();
});

app.use(express.json({ limit: "100kb" }));

// `trust proxy` is true above, which makes req.ip the leftmost X-Forwarded-For
// entry — a value the caller writes, so keying a limiter on it would let one
// client mint a fresh bucket per request. Cloudflare sets CF-Connecting-IP at
// the edge and overwrites whatever the client sent, so prefer that and fall
// back to req.ip only for a request that did not arrive through the edge.
// ipKeyGenerator collapses IPv6 to a /56, so a single allocation cannot spread
// its hits across addresses either.
const clientIpKey = (req: Request) =>
  ipKeyGenerator((req.headers["cf-connecting-ip"] as string | undefined) ?? req.ip ?? "");

// Limits are per client address and sit well above what a person browsing
// generates. They exist to bound the unattended callers: a scraper looping a
// fixed set of stop codes, or an app under development replaying deploy
// loops, both of which otherwise run against the origin with nothing to push
// back. Our own frontend server is exempt from every limiter (see
// utils/internalCaller.ts): all its page renders and chat lookups share one
// address. Liveness paths are exempt so a probe never trips a limit some abusive
// neighbour filled, and /mcp is exempt because it carries its own limiter
// below: sharing this bucket meant the global one always emptied first (it
// counts every path) and answered MCP clients with a body that is not
// JSON-RPC.
const globalRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  skip: (req) =>
    req.path === "/health" ||
    req.path === "/ping" ||
    req.path === "/mcp" ||
    isInternalCaller(req),
  message: { error: "Rate limit exceeded. Try again later." },
});

// /routes/dynamic/:name and /transport both fan out over the live vehicle
// feed, which makes them the most expensive responses here and the pair a
// single client can do the most damage with. Their bucket is drawn on top of
// the global one, so this only ever narrows what that already allows.
const liveDataRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  skip: (req) => isInternalCaller(req),
  message: { error: "Rate limit exceeded. Try again later." },
});

// Where the unattended traffic actually lands. The stop endpoints are what a
// scraper loops over, and it runs round the clock at a rate that sits under
// the global 60/minute ceiling by design, so that bucket never catches it —
// the giveaway is a request curve with no diurnal shape at all, roughly as
// busy at 04:00 as at midday. Neither stop view polls (unlike the route page,
// which refreshes every 10s), so a stop is one or two requests per
// navigation: 20/minute is around ten stop views a minute from one address,
// far above a person browsing and well under the observed scraping rate.
// /stops/:code/static is left out deliberately — it is cheap, cached, and
// loaded alongside a timetable, so counting it would halve the real budget.
// Drawn on top of the global bucket, so like the live-data one it only ever
// narrows what that already allows.
const stopDataRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  skip: (req) => isInternalCaller(req),
  message: { error: "Rate limit exceeded. Try again later." },
});

app.use(globalRateLimiter);

app.get("/stops/:code/timetable", stopDataRateLimiter, validateStopCode, getStopTimetableAction);
app.get("/stops/:code/static", validateStopCode, getStopStaticDataAction);
app.get("/stops/:code", stopDataRateLimiter, validateStopCode, getSingleStopAction);
app.get("/stops.json", getAllStopsAction);
app.get("/stops", getAllStopsAction);
app.get("/closest", getClosestStopsAction);

app.get("/routes.json", getAllRoutesAction);
app.get("/routes", getAllRoutesAction);
app.get("/routes/dynamic/:name", liveDataRateLimiter, routeInfoDynamicAction);
app.get("/routes/static/:name", routeInfoStaticAction);
app.get("/vehicle/:vehicleId", vehicleInfoAction);
app.get("/vehicle-by-plate/:plate", vehicleByPlateAction);
app.get("/transport", liveDataRateLimiter, closestTransportAction);
app.get("/disruptions", getDisruptionsAction);

app.get("/sitemap.xml", sitemapAction);

app.get("/openapi.yaml", (req, res) => {
  setStaticAssetCache(res);
  res.type("application/yaml");
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

app.get("/.well-known/openapi.yaml", (req, res) => {
  res.redirect(301, "/openapi.yaml");
});

app.get("/.well-known/ai-plugin.json", (req, res) => {
  setStaticAssetCache(res);
  res.json(buildAiPluginManifest(`${req.protocol}://${req.host}`));
});

// A2A renamed the card from agent.json to agent-card.json; serve both.
app.get(["/.well-known/agent-card.json", "/.well-known/agent.json"], async (req, res) => {
  setStaticAssetCache(res);
  res.json(buildAgentCard(`${req.protocol}://${req.host}`, await mcpManifest()));
});

app.get("/llms.txt", (req, res) => {
  setStaticAssetCache(res);
  res.type("text/plain");
  res.sendFile(path.join(__dirname, "llms.txt"));
});

app.get("/llms-full.txt", async (req, res) => {
  setStaticAssetCache(res);
  res.type("text/plain").send(buildLlmsFullTxt(`${req.protocol}://${req.host}`, await mcpManifest()));
});

app.get("/INTEGRATION.md", (req, res) => {
  setStaticAssetCache(res);
  res.type("text/markdown");
  res.sendFile(path.join(__dirname, "INTEGRATION.md"));
});

app.get("/ping", (req, res) => {
  res.json({});
});

app.get("/health", healthAction);

// express-rate-limit rather than a hand-rolled counter map: its MemoryStore
// drops the whole hit table each window, so the key space cannot grow without
// bound across the instance's lifetime.
const mcpRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  skip: (req) => isInternalCaller(req),
  handler: (req, res) =>
    res.status(429).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Rate limit exceeded. Try again later." },
      id: null,
    }),
});

app.post("/mcp", mcpRateLimiter, async (req, res) => {
  try {
    await handleMcpPostRequest(req, res);
  } catch (error) {
    console.error("MCP request handling failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// A browser opening /mcp gets a human-readable page. Everything else that
// GETs it — above all a Streamable HTTP client probing for an SSE stream —
// falls through to the 405 below, which that client knows how to handle.
// Neither answer is cacheable: Cloudflare ignores Vary: Accept, so a cached
// docs page would be handed to MCP clients probing the same URL. Vary stays
// for any cache that does honour it.
app.get("/mcp", mcpRateLimiter, async (req, res, next) => {
  res.vary("Accept");
  res.set("Cache-Control", "no-store");
  if (!wantsHtmlDocs(req.get("Accept"))) return next();
  const baseUrl = `${req.protocol}://${req.host}`;
  res.type("html").send(await renderMcpDocsPage(baseUrl));
});

app.all("/mcp", (req, res) => {
  // RFC 9110: a 405 has to say which methods the resource does take. The
  // transport is stateless, so there is no SSE stream for GET to open and
  // no session for DELETE to end — POST is the whole surface.
  res.set("Allow", "POST");
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const baseUrl = `${req.protocol}://${req.host}`;
  setStaticAssetCache(res);
  res.json({
    resource: baseUrl,
    authorization_required: false,
    authorization_servers: [],
    scopes_supported: [],
    bearer_methods_supported: [],
    resource_signing_alg_values_supported: [],
    x_no_auth_required: true,
    x_public_access:
      "All API endpoints are open and do not require authentication. Agents and clients may call them directly without obtaining tokens.",
  });
});

app.get("/.well-known/mcp/server-card.json", async (req, res) => {
  const baseUrl = `${req.protocol}://${req.host}`;
  // The card carries pkg.version, so a code push has to be able to purge it;
  // without the "long" tag the DropCache step in cloudbuild.yaml could not
  // reach it and clients kept a stale version for a day.
  setStaticAssetCache(res);
  res.json(buildMcpServerCard(baseUrl, await mcpManifest()));
});

// Other paths discovery proposals and crawlers try for the same card.
app.get(["/.well-known/mcp", "/.well-known/mcp.json"], (req, res) => {
  res.redirect(301, "/.well-known/mcp/server-card.json");
});

app.get("/mcp-icon.svg", (req, res) => {
  res.type("image/svg+xml");
  // Was a browser-side max-age=86400, which no purge can reach; moved to
  // s-maxage so a code push actually invalidates it.
  setStaticAssetCache(res);
  res.sendFile(path.join(__dirname, "mcp", "mcp-icon.svg"));
});

app.get("/robots.txt", (req, res) => {
  setStaticAssetCache(res);
  res.type("text/plain").send(buildRobotsTxt(`${req.protocol}://${req.host}`));
});

app.get("/last-modified.txt", (req, res, next) => {
  // Written by every image build from the GTFS feed's Last-Modified, so a data
  // refresh changes it: "short", not "long".
  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${5 * 60}`)
    .set("Cache-Tag", "short");
  res.sendFile(path.join(__dirname, "last-modified.txt"));
});

app.get("/favicon.ico", (req, res, next) => {
  setStaticAssetCache(res, 3600 * 24 * 31);
  res.sendFile(path.join(__dirname, "favicon.ico"));
});

// The plugin manifest and agent card point their logo here.
app.get("/favicon.png", (req, res, next) => {
  setStaticAssetCache(res, 3600 * 24 * 31);
  res.sendFile(path.join(__dirname, "favicon.png"));
});

// Applies the per-stop route overrides to the /stops listing in the browser.
// Tagged "long" like the other baked-in assets: it ships with the image, so a
// GTFS refresh leaves it alone and a code push purges it. Cloudflare caches it
// for a day on that tag, so an uncached request reaching this far is rare —
// the limiter is here so a cache-bypassing client can't turn the file read
// underneath sendFile into an amplifier.
const staticFileRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKey,
});

app.get("/stop-overrides.js", staticFileRateLimiter, (req, res) => {
  setStaticAssetCache(res);
  res.type("text/javascript");
  res.sendFile(path.join(__dirname, "public", "stopOverrides.js"));
});

app.get("/smithery.json", (req, res) => {
  setStaticAssetCache(res, 3600 * 24 * 7);
  res.sendFile(path.join(__dirname, "smithery.json"));
});

// Glama checks this path on the server's own domain to confirm who maintains
// the listing; it 404'd before, though the file was already in the repo.
app.get("/.well-known/glama.json", (req, res) => {
  setStaticAssetCache(res, 3600 * 24 * 7);
  res.sendFile(path.join(__dirname, "glama.json"));
});

// ChatGPT plugin directory domain check: the portal reads this exact token as plain
// text before it lets the MCP server be submitted. Not a secret; it only proves we
// control api.lad.lviv.ua.
const OPENAI_APPS_CHALLENGE = "KSs9ImBWcC7R_bj1oUcI0cG5EOfHQzFBLgtk8__zim8";
app.get("/.well-known/openai-apps-challenge", (req, res) => {
  setStaticAssetCache(res, 3600);
  res.type("text/plain").send(OPENAI_APPS_CHALLENGE);
});

app.get("/server.json", (req, res) => {
  setStaticAssetCache(res, 3600 * 24 * 7);
  res.sendFile(path.join(__dirname, "server.json"));
});

app.use(notFoundAction);

app.use(errorHandler);

localDb.loadDatabase({}, async () => {
  const gtfsDbConfig = JSON.parse(
    await readFile(new URL("./gtfs-import-config.json", import.meta.url), "utf8"),
  );

  await openDb(gtfsDbConfig);

  app.listen(PORT, () => {
    console.log(`Started! http://localhost:${PORT}`);
  });
});
