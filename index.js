import "dotenv/config";

import path from "path";
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
import closestTransportAction from "./actions/closestTransportAction.js";
import getAllRoutesAction from "./actions/getAllRoutesAction.js";
import sitemapAction from "./actions/sitemapAction.js";
import {
  buildMcpServerCard,
  handleMcpPostRequest,
} from "./mcp/timetableMcpServer.js";

const __dirname = path.resolve();
const app = express();

app.use(cors());

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
app.get("/transport", closestTransportAction);

app.get("/sitemap.xml", sitemapAction);

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

app.use(notFoundAction);

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
