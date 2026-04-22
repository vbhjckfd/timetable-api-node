import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import getClosestStopsAction from "../actions/getClosestStopsAction.js";
import getSingleStopAction from "../actions/getSingleStopAction.js";
import getStopTimetableAction from "../actions/getStopTimetableAction.js";
import routeInfoDynamicAction from "../actions/routeDynamicInfoAction.js";
import routeInfoStaticAction from "../actions/routeStaticInfoAction.js";
import routeFinalStopScheduleAction from "../actions/routeFinalStopScheduleAction.js";

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** Exposed in MCP `initialize` and in `/.well-known/mcp/server-card.json` (Smithery, client UIs). */
const MCP_SERVER_INFO = {
  name: "com.lad.lviv/timetable-api",
  title: "Lviv Timetable MCP",
  version: "1.0.0",
  description:
    "Read-only access to Lviv, Ukraine public transport: stops, routes, static shapes, live vehicle positions, and terminus timetables. Sourced from municipal GTFS and GTFS-RT. No API key, OAuth, or user configuration is required.",
  websiteUrl: "https://lad.lviv.ua",
};

const SMITHERY_CONFIG_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  title: "Connection options",
  description:
    "This server is fully public. Pass an empty object. Optional fields are reserved for future use and are currently ignored by the server.",
  properties: {},
  additionalProperties: false,
};

function zStopCode() {
  return z
    .number()
    .int()
    .positive()
    .describe("Municipal stop code: the number printed on stop signs and in lad.lviv.ua stop URLs.");
}

function zRouteName() {
  return z
    .string()
    .min(1)
    .describe("Route number or name as used locally (e.g. 3, 5, 2A). The API normalizes spacing and case.");
}

function mcpServerImplementation() {
  return {
    ...MCP_SERVER_INFO,
    icons: [
      {
        src: new URL("favicon.ico", `${MCP_SERVER_INFO.websiteUrl}/`).href,
        mimeType: "image/x-icon",
      },
    ],
  };
}

function createMockResponse() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: undefined,
    set(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      this.body = undefined;
      return this;
    },
  };
}

async function runAction(action, reqOverrides = {}) {
  let nextError;
  const req = {
    params: {},
    query: {},
    ...reqOverrides,
  };
  const res = createMockResponse();
  const next = (error) => {
    if (error) {
      nextError = error;
    }
  };

  await action(req, res, next);

  if (nextError) {
    throw nextError;
  }

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body,
  };
}

function formatToolResult(toolName, actionResult) {
  const { statusCode, body } = actionResult;

  if (statusCode >= 400) {
    const errorText =
      typeof body === "string" ? body : `${toolName} failed with status ${statusCode}`;
    return {
      isError: true,
      content: [{ type: "text", text: errorText }],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(body ?? null, null, 2),
      },
    ],
  };
}

const MCP_RESOURCES = {
  about: `## Lviv Timetable MCP

Read-only access to **public** timetable and live vehicle data for municipal transit in **Lviv, Ukraine** (lad.lviv.ua ecosystem).

### How to work with this server

- Prefer **tools** for structured JSON from the API.
- Use **prompts** for ready-made Ukrainian/English workflows (route status, nearby stops, slang phrasing).
- Use **resources** (this page and siblings under \`timetable://\`) for human-readable reference without calling tools.

### Data notes

- Times and positions come from upstream feeds; gaps or delays are possible.
- For precise "when does my bus arrive at *this* stop", combine a **stop code** with \`get_stop_timetable\` or location with \`get_closest_stops\`.
`,

  tools: `## Tools reference

| Tool | Purpose |
|------|---------|
| \`get_stop_by_code\` | Stop details by numeric **stop code**; optional embedded timetable. |
| \`get_stop_timetable\` | Upcoming arrivals at a stop. |
| \`get_closest_stops\` | Stops within **1 km** of lat/lon, sorted by distance. |
| \`get_route_static\` | Route shape, stops, directions, transfers (static). |
| \`get_route_dynamic\` | Live vehicle positions and direction info. |
| \`get_route_final_stop_schedule\` | Departure times from each direction's **terminus**. |

All tools are **read-only** and safe to retry.
`,

  prompts: `## Prompts reference

Prompts are reusable instruction templates. Pass the listed **arguments** when invoking a prompt.

### English

| Prompt | Arguments | Use case |
|--------|-----------|----------|
| \`route-overview\` | \`route_name\`, optional \`include_live_positions\` | Route status report (static + optional live). |
| \`route-final-stop-schedule\` | \`route_name\` | Timetables from final stops / terminuses. |
| \`commute-planner\` | \`from_stop_code\`, \`to_stop_code\` | Compare options between two stops. |
| \`nearby-stops\` | \`latitude\`, \`longitude\`, optional \`limit\` | Closest stops + arrivals table. |

### Ukrainian

| Prompt | Arguments | Use case |
|--------|-----------|----------|
| \`route-overview-ua\` | same as \`route-overview\` | Огляд маршруту. |
| \`route-final-stop-schedule-ua\` | \`route_name\` | Розклад з кінцевих. |
| \`commute-planner-ua\` | \`from_stop_code\`, \`to_stop_code\` | Планування поїздки. |
| \`nearby-stops-ua\` | \`latitude\`, \`longitude\`, optional \`limit\` | Найближчі зупинки. |
| \`ua-slang-koly-bude-avtobus\` | \`route_name\` | «Коли буде … автобус?» |
| \`ua-slang-rozklad-marshrutky\` | \`route_name\` | «Розклад маршрутки …» |
| \`ua-slang-de-tram\` | \`route_name\` | «Де трамвай …?» |
| \`ua-slang-de-trolejbus\` | \`route_name\` | «Де тролейбус …?» |
`,
};

function registerResources(server) {
  server.registerResource(
    "about",
    "timetable://about",
    {
      title: "About Lviv Timetable MCP",
      description: "Scope, usage, and data caveats for this server.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: MCP_RESOURCES.about }],
    }),
  );

  server.registerResource(
    "tools-reference",
    "timetable://reference/tools",
    {
      title: "Tools reference",
      description: "What each MCP tool returns and when to use it.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: MCP_RESOURCES.tools }],
    }),
  );

  server.registerResource(
    "prompts-reference",
    "timetable://reference/prompts",
    {
      title: "Prompts reference",
      description: "Catalog of prompt templates (EN/UA) and their arguments.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: MCP_RESOURCES.prompts }],
    }),
  );
}

function registerTools(server) {
  server.registerTool(
    "get_stop_by_code",
    {
      title: "Get Stop By Code",
      description:
        "Returns stop information by numeric stop code. Optionally includes live timetable data.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        stop_code: zStopCode(),
        include_timetable: z
          .boolean()
          .default(false)
          .describe(
            "If true, include live timetable data for this stop. If false, return stop details without embedded arrivals (faster, less data).",
          ),
      },
    },
    async ({ stop_code, include_timetable }) => {
      const actionResult = await runAction(getSingleStopAction, {
        stopCode: stop_code,
        query: { skipTimetableData: include_timetable ? "false" : "true" },
      });
      return formatToolResult("get_stop_by_code", actionResult);
    },
  );

  server.registerTool(
    "get_stop_timetable",
    {
      title: "Get Stop Timetable",
      description: "Returns current timetable arrivals for a specific stop code.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        stop_code: zStopCode(),
      },
    },
    async ({ stop_code }) => {
      const actionResult = await runAction(getStopTimetableAction, {
        stopCode: stop_code,
      });
      return formatToolResult("get_stop_timetable", actionResult);
    },
  );

  server.registerTool(
    "get_closest_stops",
    {
      title: "Get Closest Stops",
      description: "Returns stops within 1km of latitude/longitude, sorted by distance.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        latitude: z
          .number()
          .min(-90)
          .max(90)
          .describe("WGS-84 latitude in decimal degrees, for example 49.84 in central Lviv."),
        longitude: z
          .number()
          .min(-180)
          .max(180)
          .describe("WGS-84 longitude in decimal degrees, for example 24.03 in central Lviv."),
      },
    },
    async ({ latitude, longitude }) => {
      const actionResult = await runAction(getClosestStopsAction, {
        query: {
          latitude: String(latitude),
          longitude: String(longitude),
        },
      });
      return formatToolResult("get_closest_stops", actionResult);
    },
  );

  server.registerTool(
    "get_route_static",
    {
      title: "Get Route Static",
      description:
        "Returns static route data including stops, shapes, departures, and transfer options.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route_name: zRouteName(),
      },
    },
    async ({ route_name }) => {
      const actionResult = await runAction(routeInfoStaticAction, {
        params: { name: route_name },
      });
      return formatToolResult("get_route_static", actionResult);
    },
  );

  server.registerTool(
    "get_route_dynamic",
    {
      title: "Get Route Dynamic",
      description:
        "Returns live vehicle positions and direction details for a route.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route_name: zRouteName(),
      },
    },
    async ({ route_name }) => {
      const actionResult = await runAction(routeInfoDynamicAction, {
        params: { name: route_name },
      });
      return formatToolResult("get_route_dynamic", actionResult);
    },
  );

  server.registerTool(
    "get_route_final_stop_schedule",
    {
      title: "Get Route Final Stop Schedule",
      description:
        "Returns departure-time schedules from each direction's terminus (final stop) for a route.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route_name: zRouteName(),
      },
    },
    async ({ route_name }) => {
      const actionResult = await runAction(routeFinalStopScheduleAction, {
        params: { name: route_name },
      });
      return formatToolResult("get_route_final_stop_schedule", actionResult);
    },
  );
}

function registerPrompts(server) {
  server.registerPrompt(
    "route-overview",
    {
      title: "Route Overview",
      description:
        "Build a status report for a bus/tram/trolley route using static and live route data.",
      argsSchema: {
        route_name: z
          .string()
          .min(1)
          .describe("Route short name, for example: 3A, 9, 2"),
        include_live_positions: z
          .string()
          .optional()
          .describe("Set to 'true' or 'false' to control live vehicle position usage"),
      },
    },
    ({ route_name, include_live_positions }) => {
      const shouldIncludeLivePositions = include_live_positions !== "false";
      const liveStep = shouldIncludeLivePositions
        ? `2) Call \`get_route_dynamic\` with \`route_name=${route_name}\`. Use this to summarize live vehicles per direction and note if no live vehicles are visible.`
        : "2) Skip live vehicle position checks.";

      return {
        description: "Route status summary prompt for Lviv public transport.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Create a concise status report for route "${route_name}" in Lviv.`,
                "",
                "Workflow:",
                `1) Call \`get_route_static\` with \`route_name=${route_name}\` and summarize main route structure (key stops, direction names if available).`,
                liveStep,
                "3) If static data has transfer options, mention the most useful transfer points.",
                "",
                "Output format:",
                "- Header: `Route <name> Status`",
                "- Use transport emoji when clear from data (`🚌` bus, `🚃` tram, `🚎` trolleybus).",
                "- Provide sections: `Overview`, `Live status`, `Transfer notes`, `Data caveats`.",
                "- If any required data call fails, clearly state what is missing and continue with available data.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "route-final-stop-schedule",
    {
      title: "Route Final Stop Schedule",
      description:
        "Fetch terminus departure times for both directions and present them clearly (good for 'schedule from final stops' questions).",
      argsSchema: {
        route_name: z
          .string()
          .min(1)
          .describe("Route short name, for example: 3A, 9, 2"),
      },
    },
    ({ route_name }) => ({
      description: "Route terminus timetable prompt (final stop departures).",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Show the departure schedule from final stops (terminus) for route "${route_name}" in Lviv.`,
              "",
              "Tool workflow:",
              `1) Call \`get_route_final_stop_schedule\` with \`route_name=${route_name}\`.`,
              `2) Optionally call \`get_route_static\` with the same \`route_name\` if you need extra context (stop ordering, transfers).`,
              "",
              "Output format:",
              "- Start with a one-line route summary (type + route number/name if present).",
              "- Then two sections: `Direction 0` and `Direction 1` (use the terminus stop name + code).",
              "- Under each, show departures as a compact list; if departures are empty, say so explicitly.",
              "- If the tool errors, explain what failed and what the user should try next (alternate spelling, numeric id, etc.).",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "commute-planner",
    {
      title: "Commute Planner",
      description:
        "Compare route options between two stop codes and prioritize lower waiting times.",
      argsSchema: {
        from_stop_code: z.string().describe("Origin stop code, e.g. 1234"),
        to_stop_code: z.string().describe("Destination stop code, e.g. 5678"),
      },
    },
    ({ from_stop_code, to_stop_code }) => ({
      description: "Transit commute planning prompt using available stop and route tools.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Plan a trip from stop ${from_stop_code} to stop ${to_stop_code} in Lviv.`,
              "",
              "Tool workflow:",
              `1) Call \`get_stop_by_code\` for both stops (\`include_timetable=true\`) to validate stop names and basic route context.`,
              `2) Call \`get_stop_timetable\` for both stops to get upcoming arrivals.`,
              "3) Identify candidate routes that can plausibly connect origin to destination directly or with one transfer.",
              "4) For each strong candidate route, call `get_route_static` to verify stop sequence and transfer feasibility.",
              "5) Prioritize recommendations by shortest expected waiting time at the origin first, then by transfer count.",
              "",
              "Output format:",
              "- Start with `Best option` and include estimated wait in minutes.",
              "- Then list up to 3 alternatives in a short ranked list.",
              "- Include a `Why this ranking` section with wait-time and transfer tradeoffs.",
              "- If data is insufficient, explain exactly which stop/route data is missing.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "nearby-stops",
    {
      title: "Nearby Stops",
      description:
        "List the closest stops to coordinates and show upcoming arrivals in a markdown table.",
      argsSchema: {
        latitude: z.string().describe("User latitude in decimal degrees"),
        longitude: z.string().describe("User longitude in decimal degrees"),
        limit: z
          .string()
          .optional()
          .describe("Maximum number of nearby stops to include (default 5)"),
      },
    },
    ({ latitude, longitude, limit }) => {
      const safeLimit = Number.parseInt(limit ?? "5", 10);
      const normalizedLimit = Number.isNaN(safeLimit)
        ? 5
        : Math.min(Math.max(safeLimit, 1), 10);

      return {
        description: "Nearby stop arrivals prompt for location-based transit summary.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Find the ${normalizedLimit} closest stops to coordinates (${latitude}, ${longitude}) in Lviv.`,
                "",
                "Tool workflow:",
                `1) Call \`get_closest_stops\` with \`latitude=${latitude}\`, \`longitude=${longitude}\`.`,
                `2) Keep the first ${normalizedLimit} stops from the distance-sorted list.`,
                "3) For each selected stop, call `get_stop_timetable` using the stop code to fetch upcoming arrivals.",
                "",
                "Output format:",
                "- Return one markdown table with columns: `Stop`, `Code`, `Distance`, `Next arrivals`.",
                "- Show arrival countdowns in minutes where possible.",
                "- Use transport emoji (`🚌`, `🚃`, `🚎`) for each arrival when route type can be inferred.",
                "- Add a short `Notes` line if any stop has missing or stale timetable data.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "route-overview-ua",
    {
      title: "Огляд маршруту",
      description:
        "Зведений статус для автобусного/трамвайного/тролейбусного маршруту на основі статичних і динамічних даних.",
      argsSchema: {
        route_name: z
          .string()
          .min(1)
          .describe("Коротка назва маршруту, наприклад: 3A, 9, 2"),
        include_live_positions: z
          .string()
          .optional()
          .describe("Вкажіть 'true' або 'false', щоб увімкнути/вимкнути живі позиції транспорту"),
      },
    },
    ({ route_name, include_live_positions }) => {
      const shouldIncludeLivePositions = include_live_positions !== "false";
      const liveStep = shouldIncludeLivePositions
        ? `2) Виклич \`get_route_dynamic\` з \`route_name=${route_name}\`. Коротко підсумуй живі ТЗ за напрямками і зазнач, якщо живих ТЗ не видно.`
        : "2) Пропусти перевірку живих позицій транспорту.";

      return {
        description: "UA: зведений статус маршруту для громадського транспорту Львова.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Зроби стислий статус-звіт для маршруту "${route_name}" у Львові.`,
                "",
                "Алгоритм:",
                `1) Виклич \`get_route_static\` з \`route_name=${route_name}\` і коротко опиши структуру маршруту (ключові зупинки, назви напрямків, якщо є).`,
                liveStep,
                "3) Якщо в статичних даних є варіанти пересадок, згадай найкорисніші точки пересадки.",
                "",
                "Формат відповіді:",
                "- Заголовок: `Статус маршруту <назва>`",
                "- Додай емодзі типу транспорту, якщо це можна зрозуміти з даних (`🚌` автобус, `🚃` трамвай, `🚎` тролейбус).",
                "- Розділи: `Огляд`, `Живий стан`, `Пересадки`, `Обмеження даних`.",
                "- Якщо якийсь обов’язковий виклик інструменту не вдався, чітко вкажи, чого не вистачає, і продовжуй з доступними даними.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "route-final-stop-schedule-ua",
    {
      title: "Розклад з кінцевих зупинок",
      description:
        "Отримай час відправлень з кінцевих зупинок для обох напрямків і покажи зрозуміло.",
      argsSchema: {
        route_name: z
          .string()
          .min(1)
          .describe("Коротка назва маршруту, наприклад: 3A, 9, 2"),
      },
    },
    ({ route_name }) => ({
      description: "UA: розклад відправлень з кінцевих зупинок (терміналів) для маршруту.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Покажи розклад відправлень з кінцевих зупинок (терміналів) для маршруту "${route_name}" у Львові.`,
              "",
              "Алгоритм інструментів:",
              `1) Виклич \`get_route_final_stop_schedule\` з \`route_name=${route_name}\`.`,
              `2) За потреби виклич \`get_route_static\` з тим самим \`route_name\`, якщо треба додатковий контекст (порядок зупинок, пересадки).`,
              "",
              "Формат відповіді:",
              "- Почни з одного рядка-резюме про маршрут (тип + номер/назва, якщо є).",
              "- Далі два розділи: `Напрямок 0` і `Напрямок 1` (вкажи назву кінцевої зупинки + код).",
              "- У кожному розділі покажи відправлення компактним списком; якщо список порожній — прямо так і скажи.",
              "- Якщо інструмент повернув помилку, поясни що саме не вдалося і що спробувати далі (альтернативне написання, числовий id тощо).",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "commute-planner-ua",
    {
      title: "Планувальник поїздки",
      description:
        "Порівняй варіанти між двома кодами зупинок і пріоритезуй менший час очікування.",
      argsSchema: {
        from_stop_code: z.string().describe("Код зупинки відправлення, наприклад 1234"),
        to_stop_code: z.string().describe("Код зупинки призначення, наприклад 5678"),
      },
    },
    ({ from_stop_code, to_stop_code }) => ({
      description: "UA: планування поїздки з використанням доступних інструментів зупинок і маршрутів.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Сплануй поїздку від зупинки ${from_stop_code} до зупинки ${to_stop_code} у Львові.`,
              "",
              "Алгоритм інструментів:",
              `1) Виклич \`get_stop_by_code\` для обох зупинок (\`include_timetable=true\`), щоб підтвердити назви та базовий контекст маршрутів.`,
              `2) Виклич \`get_stop_timetable\` для обох зупинок, щоб отримати найближчі прибуття.`,
              "3) Визнач кандидатні маршрути, які реалістично з’єднують початок і кінець безпосередньо або з однією пересадкою.",
              "4) Для кожного сильного кандидата виклич `get_route_static`, щоб перевірити послідовність зупинок і можливість пересадки.",
              "5) Ранжуй рекомендації: спочатку мінімальне очікування на початковій зупинці, потім кількість пересадок.",
              "",
              "Формат відповіді:",
              "- Почни з `Найкращий варіант` і вкажи очікування в хвилинах.",
              "- Далі до 3 альтернатив коротким списком.",
              "- Додай розділ `Чому саме такий рейтинг` з компромісами між очікуванням і пересадками.",
              "- Якщо даних недостатньо, поясни, яких саме даних по зупинці/маршруту не вистачає.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "nearby-stops-ua",
    {
      title: "Найближчі зупинки",
      description:
        "Знайди найближчі зупинки до координат і покажи найближчі прибуття у markdown-таблиці.",
      argsSchema: {
        latitude: z.string().describe("Широта користувача у десяткових градусах"),
        longitude: z.string().describe("Довгота користувача у десяткових градусах"),
        limit: z
          .string()
          .optional()
          .describe("Максимальна кількість найближчих зупинок (за замовчуванням 5)"),
      },
    },
    ({ latitude, longitude, limit }) => {
      const safeLimit = Number.parseInt(limit ?? "5", 10);
      const normalizedLimit = Number.isNaN(safeLimit)
        ? 5
        : Math.min(Math.max(safeLimit, 1), 10);

      return {
        description: "UA: підбір найближчих зупинок і прибуття за координатами.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Знайди ${normalizedLimit} найближчих зупинок до координат (${latitude}, ${longitude}) у Львові.`,
                "",
                "Алгоритм інструментів:",
                `1) Виклич \`get_closest_stops\` з \`latitude=${latitude}\`, \`longitude=${longitude}\`.`,
                `2) Візьми перші ${normalizedLimit} зупинок із відсортованого за відстанню списку.`,
                "3) Для кожної обраної зупинки виклич `get_stop_timetable` за кодом зупинки, щоб отримати найближчі прибуття.",
                "",
                "Формат відповіді:",
                "- Одна markdown-таблиця з колонками: `Зупинка`, `Код`, `Відстань`, `Найближчі прибуття`.",
                "- Де можливо, показуй час до прибуття в хвилинах.",
                "- Додавай емодзі (`🚌`, `🚃`, `🚎`) для кожного прибуття, якщо тип транспорту можна вивести з даних.",
                "- Додай короткий рядок `Примітки`, якщо для якоїсь зупинки немає або застарілий розклад.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "ua-slang-koly-bude-avtobus",
    {
      title: "Коли буде автобус (UA slang)",
      description:
        "Відповідає на розмовні запитання на кшталт «коли буде 61 автобус?» — орієнтується на маршрут і (за можливості) живі позиції.",
      argsSchema: {
        route_name: z
          .string()
          .min(1)
          .describe("Номер/назва маршруту, наприклад: 61, 3A"),
      },
    },
    ({ route_name }) => ({
      description: "UA slang: «коли буде … автобус»",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Користувач питає розмовною мовою про автобус маршруту "${route_name}" у Львові (на кшталт: «коли буде ${route_name} автобус?»).`,
              "",
              "Що зробити:",
              `1) Виклич \`get_route_static\` з \`route_name=${route_name}\`. Якщо не знайшло — спробуй близькі варіанти написання (наприклад, з літерним суфіксом) і поясни, який варіант спрацював.`,
              `2) Виклич \`get_route_dynamic\` з \`route_name=${route_name}\` і коротко опиши, де зараз видно ТЗ (якщо їх немає — прямо скажи).`,
              "",
              "Важливо:",
              "- Якщо користувач не дав код зупинки, не вигадуй час прибуття «з голови»: поясни, що для точного «коли буде» потрібен код зупинки, і запропонуй варіанти (наприклад, `nearby-stops-ua` якщо є координати).",
              "",
              "Формат відповіді (українською, коротко):",
              "- `Що знайшли по маршруту`",
              "- `Де зараз автобуси` (якщо є дані)",
              "- `Що потрібно для точного часу` (якщо бракує зупинки)",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "ua-slang-rozklad-marshrutky",
    {
      title: "Розклад маршрутки (UA slang)",
      description:
        "Відповідає на запитання на кшталт «розклад руху маршрутки 61» — трактує як маршрут і збирає доступні дані з API.",
      argsSchema: {
        route_name: z
          .string()
          .min(1)
          .describe("Номер/назва маршруту, наприклад: 61, 3A"),
      },
    },
    ({ route_name }) => ({
      description: "UA slang: «розклад руху маршрутки …»",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Користувач питає про автобус / «маршрутку» "${route_name}" у Львові (на кшталт: «розклад руху маршрутки ${route_name}»).`,
              "",
              "Що зробити:",
              `1) Виклич \`get_route_static\` з \`route_name=${route_name}\`. Якщо не знайшло — спробуй альтернативні написання і явно скажи, що саме спрацювало.`,
              `2) Виклич \`get_route_dynamic\` з \`route_name=${route_name}\` і додай «живий» контекст, якщо він є.`,
              `3) Виклич \`get_route_final_stop_schedule\` з \`route_name=${route_name}\` і зроби «розклад з кінцевих» основою відповіді (часи відправлень з терміналів для обох напрямків).`,
              "",
              "Нюанси формулювання:",
              "- У Львові «маршрутка» часто співпадає з номером маршруту в даних, але не завжди. Не припускай зайвого: орієнтуйся на те, що повертає API.",
              "- Якщо `get_route_final_stop_schedule` повертає порожні списки відправлень — чесно скажи, що для цього маршруту/напрямку немає доступних часів у джерелі даних.",
              "",
              "Формат відповіді (українською):",
              "- `Що відомо про маршрут ${route_name}`",
              "- `Що показує «зараз на лінії»`",
              "- `Обмеження / невизначеність`",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "ua-slang-de-tram",
    {
      title: "Де трамвай (UA slang)",
      description:
        "Відповідає на запитання на кшталт «де трамвай 02?» — показує живі позиції та базовий контекст маршруту.",
      argsSchema: {
        route_name: z
          .string()
          .min(1)
          .describe("Номер/назва маршруту, наприклад: 02, 2"),
      },
    },
    ({ route_name }) => ({
      description: "UA slang: «де трамвай …»",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Користувач питає розмовною мовою: «де трамвай ${route_name}?» (Львів).`,
              "",
              "Що зробити:",
              `1) Виклич \`get_route_static\` з \`route_name=${route_name}\` (для контексту напрямків/ключових зупинок, якщо це допомагає).`,
              `2) Виклич \`get_route_dynamic\` з \`route_name=${route_name}\` і опиши, де зараз видно трамваї (координати/напрямок — як у відповіді API).`,
              "",
              "Формат відповіді (українською, практично):",
              "- `Коротко по маршруту`",
              "- `Де зараз трамваї` (якщо порожньо — скажи прямо)",
              "- `Як уточнити код зупинки` (якщо користувач має код зупинки — запропонуй `get_stop_timetable`)",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "ua-slang-de-trolejbus",
    {
      title: "Де тролейбус (UA slang)",
      description:
        "Відповідає на запитання на кшталт «де тролейбус 33?» — показує живі позиції та базовий контекст маршруту.",
      argsSchema: {
        route_name: z
          .string()
          .min(1)
          .describe("Номер/назва маршруту, наприклад: 33"),
      },
    },
    ({ route_name }) => ({
      description: "UA slang: «де тролейбус …»",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Користувач питає розмовною мовою: «де тролейбус ${route_name}?» (Львів).`,
              "",
              "Що зробити:",
              `1) Виклич \`get_route_static\` з \`route_name=${route_name}\` (для контексту напрямків/ключових зупинок, якщо це допомагає).`,
              `2) Виклич \`get_route_dynamic\` з \`route_name=${route_name}\` і опиши, де зараз видно тролейбуси (координати/напрямок — як у відповіді API).`,
              "",
              "Формат відповіді (українською, практично):",
              "- `Коротко по маршруту`",
              "- `Де зараз тролейбуси` (якщо порожньо — скажи прямо)",
              "- `Як уточнити код зупинки` (якщо користувач має код зупинки — запропонуй `get_stop_timetable`)",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

export function createTimetableMcpServer() {
  const server = new McpServer(
    mcpServerImplementation(),
    {
      capabilities: {
        logging: {},
      },
    },
  );

  registerTools(server);
  registerResources(server);
  registerPrompts(server);
  return server;
}

export async function handleMcpPostRequest(req, res) {
  const server = createTimetableMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    await transport.close();
    await server.close();
  }
}

export function buildMcpServerCard(baseUrl) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const iconUrl = new URL("favicon.ico", `${normalizedBaseUrl}/`).href;

  return {
    ...MCP_SERVER_INFO,
    icons: [
      {
        src: iconUrl,
        mimeType: "image/x-icon",
      },
    ],
    remotes: [
      {
        type: "streamable-http",
        url: `${normalizedBaseUrl}/mcp`,
      },
    ],
    authentication: {
      type: "none",
    },
    configSchema: SMITHERY_CONFIG_JSON_SCHEMA,
  };
}
