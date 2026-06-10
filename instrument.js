// dotenv must load before Sentry.init reads SENTRY_DSN — this module is
// imported first in index.js, before its own `import "dotenv/config"`.
import "dotenv/config";
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: true,
    tracesSampleRate: 0.1,
  });
}
