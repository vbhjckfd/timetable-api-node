import db from "../connections/timetableSqliteDb.js";
import {
  normalizeRouteName,
  routeNameToUrlFriendly,
} from "../utils/appHelpers.js";

const BASE_URL = "https://lad.lviv.ua";

export default (req, res) => {
  const longCacheAgeSeconds = 30 * 24 * 3600;
  const stops = db
    .getCollection("stops")
    .chain()
    .find({})
    .simplesort("code")
    .data();
  const routes = db
    .getCollection("routes")
    .chain()
    .find({})
    .simplesort("short_name")
    .data();

  const stopUrls = stops
    .map((s) => `  <url><loc>${BASE_URL}/stops/${s.code}</loc></url>`)
    .join("\n");

  const routeUrls = routes
    .map(
      (r) =>
        `  <url><loc>${BASE_URL}/route/${routeNameToUrlFriendly(normalizeRouteName(r.short_name))}</loc></url>`,
    )
    .join("\n");

  const scheduleUrls = routes
    .map(
      (r) =>
        `  <url><loc>${BASE_URL}/route/${routeNameToUrlFriendly(normalizeRouteName(r.short_name))}/schedule</loc></url>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE_URL}/</loc></url>
${stopUrls}
${routeUrls}
${scheduleUrls}
</urlset>`;

  res.set("Content-Type", "application/xml");
  res.set("Cache-Control", `public, max-age=0, s-maxage=${longCacheAgeSeconds}`);
  res.set("Cache-Tag", "long");
  res.send(xml);
};
