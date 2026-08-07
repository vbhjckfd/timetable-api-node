import db from "../connections/timetableSqliteDb.js";
import {
  contactBannerHtml,
  contactBannerStyle,
  escapeHtml,
} from "../utils/appHelpers.js";

export default async (req, res, next) => {
  // Tagged "short" so the post-deploy cache drop in cloudbuild.yaml purges it:
  // this listing changes whenever a GTFS import adds or removes a stop, and a
  // "long"-tagged copy survived deploys for up to the full 30 days.
  const cacheAgeSeconds = 30 * 24 * 3600;
  const stopsRaw = db
    .getCollection("stops")
    .chain()
    .find({})
    .simplesort("code")
    .data();
  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${cacheAgeSeconds}`)
    .set("Cache-Tag", "short");

  if (req.path.endsWith(".json")) {
    res.json(
      stopsRaw.map((s) => {
        const loc = s.location.coordinates;
        return {
          code: s.code,
          sign: `https://offline.lad.lviv.ua/${s.code}`,
          sign_pdf: `https://pdf.lad.lviv.ua/${s.code}.pdf`,
          name: s.name,
          eng_name: s.eng_name,
          location: [loc[0], loc[1]],
          routes: s.transfers.map((i) => i["route"]).sort(),
        };
      }),
    );
  } else {
    const baseUrl = `${req.protocol}://${req.hostname}`;
    const canonical = `${baseUrl}/stops`;
    const title = "Зупинки громадського транспорту Львова";
    const description = "Повний список зупинок громадського транспорту Львова з кодами, координатами та маршрутами.";

    let result = `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | lad.lviv.ua</title>
<meta name="description" content="${description}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<link rel="icon" href="/favicon.ico">
<style>
table, th { text-align: left; }
a { text-decoration: none; }
.route.removed { color: red; text-decoration: line-through; }
.route.added { color: green; }
.route { cursor: pointer; }
#overrides-summary { margin-top: 1em; }
#overrides-summary textarea { width: 100%; max-width: 600px; box-sizing: border-box; }
${contactBannerStyle()}
</style>
<script type="module" src="/stop-overrides.js"></script>
</head>
<body>
${contactBannerHtml("stops")}
<table>
`;

    result += `<tr>
        <th>Код</th>
        <th>Макет</th>
        <th>Назва</th>
        <th>Розташування</th>
        <th>Маршрути</th>
        </tr>`;

    for (let s of stopsRaw) {
      const loc = s.location.coordinates;

      const transfers = s.transfers
        .map((i) => {
          return i["route"];
        })
        .sort();

      // data-code and data-routes are what /stop-overrides.js rewrites the row
      // from: the served HTML stays the plain upstream listing, cacheable for
      // 30 days, and the overrides are applied in the browser.
      result += `<tr data-code="${s.code}">
            <td><a target="blank" href="https://lad.lviv.ua/stops/${s.code}">${s.code}</a> (${s.microgiz_id})</td>
            <td>
                <a target="blank" data-kind="svg" href="https://offline.lad.lviv.ua/${s.code}">SVG</a>
                &nbsp;
                <a target="blank" data-kind="pdf" href="https://pdf.lad.lviv.ua/${s.code}.pdf">PDF</a>
            </td>
            <td>${escapeHtml(s.name)}</td>
            <td><a target="blank" href="https://www.openstreetmap.org/?mlat=${loc[0]}&mlon=${loc[1]}#map=18/${loc[0]}/${loc[1]}">${loc[0]}, ${loc[1]}</a></td>
            <td data-routes="${escapeHtml(transfers.join(" "))}">${transfers
              .map((r) => `<span class="route kept" data-route="${escapeHtml(r)}">${escapeHtml(r)}</span>`)
              .join(" ")}</td>
            </tr>`;
    }
    // Filled and shown by /stop-overrides.js only once there is at least one
    // override — nothing rendered here, since overrides live in the browser's
    // own localStorage and the server has no idea whether there are any.
    result += `</table>
<div id="overrides-summary" style="display:none;">
<h2>Підсумок змін для власника бази</h2>
<textarea id="overrides-summary-text" readonly rows="6"></textarea><br>
<button type="button" id="overrides-summary-copy">Скопіювати</button>
</div>
</body>\n</html>`;

    res.send(result);
  }
};
