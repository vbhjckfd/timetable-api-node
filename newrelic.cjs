'use strict'

/**
 * New Relic agent configuration.
 *
 * The agent is CommonJS and reads this file with require(), so it must stay
 * .cjs even though the rest of the project is ESM ("type": "module").
 *
 * No secrets live here: the license key comes from NEW_RELIC_LICENSE_KEY.
 * Without that variable the agent stays off, the same way Sentry stays off
 * without SENTRY_DSN (see instrument.js).
 */
exports.config = {
  agent_enabled: Boolean(process.env.NEW_RELIC_LICENSE_KEY),
  app_name: [process.env.NEW_RELIC_APP_NAME || 'timetable-api-node'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  logging: {
    // Cloud Run has no log shipper for files; write to the container stdout.
    filepath: 'stdout',
    level: process.env.NEW_RELIC_LOG_LEVEL || 'info',
  },
  distributed_tracing: {
    enabled: true,
  },
  application_logging: {
    // Log lines already go to Cloud Logging; only keep the metrics.
    forwarding: { enabled: false },
    local_decorating: { enabled: false },
    metrics: { enabled: true },
  },
  error_collector: {
    // Crawlers probe /mcp constantly: GET is answered with a deliberate 405
    // (the transport is stateless, so there is no SSE stream to open) and
    // 404s are noise. Neither is an application fault, so keep them out of
    // the error rate. 400s stay visible: they mean a client sent a body the
    // JSON-RPC schema rejected, which is worth seeing.
    ignore_status_codes: [404, 405],
  },
  transaction_tracer: {
    enabled: true,
    record_sql: 'obfuscated',
  },
  rules: {
    // The Docker HEALTHCHECK hits /health every 60s; keep it out of the data.
    ignore: ['^/health'],
  },
  allow_all_headers: true,
  attributes: {
    exclude: [
      'request.headers.cookie',
      'request.headers.authorization',
      'request.headers.proxyAuthorization',
      'request.headers.setCookie*',
      'request.headers.x*',
      'response.headers.cookie',
      'response.headers.authorization',
      'response.headers.proxyAuthorization',
      'response.headers.setCookie*',
      'response.headers.x*',
    ],
  },
}
