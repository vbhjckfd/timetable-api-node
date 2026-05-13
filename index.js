import "./instrument.js";
import "dotenv/config";

import * as Sentry from "@sentry/node";
import path from "path";
const __dirname = import.meta.dirname;
const PORT = process.env.PORT || 8080;

import { openDb } from "gtfs";
import { readFile } from "fs/promises";
import cors from "cors";
import express from "express";
import bodyParser from "body-parser";
import localDb from "./connections/timetableSqliteDb.js";

import notFoundAction from "./actions/notFoundAction.js";
import validateStopCode from "./utils/stopCodeMiddleware.js";

import getClosestStopsAction from "./actions/getClosestStopsAction.js";
import getSingleStopAction from "./actions/getSingleStopAction.js";
import getStopTimetableAction from "./actions/getStopTimetableAction.js";
import getStopStaticDataAction from "./actions/getStopStaticDataAction.js";
import getAllStopsAction from "./actions/getAllStopsAction.js";
import routeInfoDynamicAction from "./actions/routeDynamicInfoAction.js";
import routeInfoStaticAction from "./actions/routeStaticInfoAction.js";
import vehicleInfoAction from "./actions/vehicleInfoAction.js";
import vehicleByPlateAction from "./actions/vehicleByPlateAction.js";
import closestTransportAction from "./actions/closestTransportAction.js";
import getAllRoutesAction from "./actions/getAllRoutesAction.js";
import sitemapAction from "./actions/sitemapAction.js";
import {
  buildMcpServerCard,
  handleMcpPostRequest,
} from "./mcp/timetableMcpServer.js";

const app = express();

app.use(cors());

app.use((req, res, next) => {
  const baseUrl = `https://${req.get("host")}`;
  res.set("Link", '</openapi.yaml>; rel="describedby"');
  res.set("X-MCP-Server", `${baseUrl}/.well-known/mcp/server-card.json`);
  next();
});

app.use(bodyParser.json({ limit: "100kb" }));

app.get("/stops/:code/timetable", validateStopCode, getStopTimetableAction);
app.get("/stops/:code/static", validateStopCode, getStopStaticDataAction);
app.get("/stops/:code", validateStopCode, getSingleStopAction);
app.get("/stops.json", getAllStopsAction);
app.get("/stops", getAllStopsAction);
app.get("/closest", getClosestStopsAction);

app.get("/routes.json", getAllRoutesAction);
app.get("/routes", getAllRoutesAction);
app.get("/routes/dynamic/:name", routeInfoDynamicAction);
app.get("/routes/static/:name", routeInfoStaticAction);
app.get("/vehicle/:vehicleId", vehicleInfoAction);
app.get("/vehicle-by-plate/:plate", vehicleByPlateAction);
app.get("/transport", closestTransportAction);

app.get("/sitemap.xml", sitemapAction);

app.get("/openapi.yaml", (req, res) => {
  res.set("Cache-Control", `public, max-age=0, s-maxage=${3600 * 24}`);
  res.type("application/yaml");
  res.sendFile(path.join(__dirname, "openapi.yaml"));
});

app.get("/.well-known/openapi.yaml", (req, res) => {
  res.redirect(301, "/openapi.yaml");
});

app.get("/.well-known/ai-plugin.json", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  res.set("Cache-Control", `public, max-age=0, s-maxage=${3600 * 24}`);
  res.json({
    schema_version: "v1",
    name_for_human: "Lviv Public Transport",
    name_for_model: "lviv_timetable",
    description_for_human:
      "Real-time and static public transport data for Lviv, Ukraine — stops, routes, timetables, live vehicle positions. No API key required.",
    description_for_model:
      "Provides real-time arrivals, live vehicle positions, static timetables, route shapes, and stop discovery for public transport in Lviv, Ukraine. Data sourced from municipal GTFS-RT feeds. All endpoints are read-only and require no authentication. Use stop numeric codes (e.g. 707) and route short names (e.g. T30, 32A).",
    auth: { type: "none" },
    api: {
      type: "openapi",
      url: `${baseUrl}/openapi.yaml`,
    },
    logo_url: `${baseUrl}/favicon.png`,
    contact_email: "vbhjckfd@gmail.com",
    legal_info_url: "https://lad.lviv.ua",
  });
});

app.get("/.well-known/agent.json", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  res.set("Cache-Control", `public, max-age=0, s-maxage=${3600 * 24}`);
  res.json({
    name: "Lviv Public Transport",
    description:
      "Real-time and static public transport data for Lviv, Ukraine: stops, routes, timetables, and live vehicle positions. No API key required.",
    url: baseUrl,
    version: "1.1.0",
    iconUrl: `${baseUrl}/favicon.png`,
    documentationUrl: `${baseUrl}/llms.txt`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "get_stop_realtime",
        name: "Get Stop Realtime",
        description:
          "Live arrivals and vehicle positions at a stop by numeric stop code (e.g. 707).",
        tags: ["transit", "realtime", "arrivals", "lviv"],
        inputModes: ["text/plain"],
        outputModes: ["application/json"],
        examples: ["What buses are arriving at stop 707?", "Live arrivals for stop 1234"],
      },
      {
        id: "get_route_static",
        name: "Get Route Static",
        description:
          "Route metadata, stop lists, departure times, and polylines for both directions.",
        tags: ["transit", "route", "timetable", "lviv"],
        inputModes: ["text/plain"],
        outputModes: ["application/json"],
        examples: ["Show me route T30 stops", "Route 32A schedule"],
      },
      {
        id: "get_route_realtime",
        name: "Get Route Realtime",
        description: "Live vehicle positions for all vehicles currently running on a route.",
        tags: ["transit", "realtime", "vehicles", "lviv"],
        inputModes: ["text/plain"],
        outputModes: ["application/json"],
        examples: ["Where are all tram 6 vehicles right now?"],
      },
      {
        id: "get_stops_around_location",
        name: "Get Stops Around Location",
        description: "Discover transit stops near a given latitude/longitude within a radius.",
        tags: ["transit", "location", "stops", "lviv"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
        examples: ["Find stops near 49.84, 24.03", "Stops within 300m of my location"],
      },
      {
        id: "get_stop_geometry",
        name: "Get Stop Geometry",
        description:
          "Static map context for a stop: stop marker and route polylines for all serving routes.",
        tags: ["transit", "geometry", "map", "lviv"],
        inputModes: ["text/plain"],
        outputModes: ["application/json"],
        examples: ["Get map data for stop 707"],
      },
    ],
    authentication: { schemes: [] },
    provider: {
      organization: "lad.lviv.ua",
      url: "https://lad.lviv.ua",
    },
    mcpEndpoint: `${baseUrl}/mcp`,
    mcpServerCard: `${baseUrl}/.well-known/mcp/server-card.json`,
    openApiUrl: `${baseUrl}/openapi.yaml`,
  });
});

app.get("/llms.txt", (req, res) => {
  res.set("Cache-Control", `public, max-age=0, s-maxage=${3600 * 24}`);
  res.type("text/plain");
  res.sendFile(path.join(__dirname, "llms.txt"));
});

app.get("/INTEGRATION.md", (req, res) => {
  res.set("Cache-Control", `public, max-age=0, s-maxage=${3600 * 24}`);
  res.type("text/markdown");
  res.sendFile(path.join(__dirname, "INTEGRATION.md"));
});

app.get("/ping", (req, res) => {
  res.json({});
});

app.post("/mcp", async (req, res) => {
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

app.all("/mcp", (req, res) => {
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
  const baseUrl = `https://${req.get("host")}`;
  res.set("Cache-Control", `public, max-age=0, s-maxage=${3600 * 24}`);
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

app.get("/.well-known/mcp/server-card.json", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  res.json(buildMcpServerCard(baseUrl));
});

app.get("/mcp-icon.svg", (req, res) => {
  res.type("image/svg+xml");
  res.set("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(__dirname, "mcp", "mcp-icon.svg"));
});

app.get("/robots.txt", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const lines = [
    "User-agent: *",
    "Disallow: /private/",
    "",
    "# Non-standard hint for AI agent discovery:",
    `# mcp-server: ${baseUrl}/.well-known/mcp/server-card.json`,
  ];
  res.type("text/plain").send(lines.join("\n"));
});

app.get("/last-modified.txt", (req, res, next) => {
  res.set("Cache-Control", `public, max-age=0, s-maxage=${5 * 60}`);
  res.sendFile(path.join(__dirname, "last-modified.txt"));
});

app.get("/favicon.ico", (req, res, next) => {
  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${3600 * 24 * 31}`)
    .set("Cache-Tag", "long");
  res.sendFile(path.join(__dirname, "favicon.ico"));
});

app.get("/smithery.json", (req, res) => {
  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${3600 * 24 * 7}`)
    .set("Cache-Tag", "long");
  res.sendFile(path.join(__dirname, "smithery.json"));
});

app.get("/server.json", (req, res) => {
  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${3600 * 24 * 7}`)
    .set("Cache-Tag", "long");
  res.sendFile(path.join(__dirname, "server.json"));
});

app.use(notFoundAction);

Sentry.setupExpressErrorHandler(app);

app.use(function (err, req, res, next) {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

app.on("ready", () => {
  app.listen(PORT, () => {
    console.log("Started!");
  });
});

localDb.loadDatabase({}, async () => {
  const gtfsDbConfig = JSON.parse(
    await readFile(new URL("./gtfs-import-config.json", import.meta.url)),
  );

  await openDb(gtfsDbConfig);

  app.emit("ready");
});
