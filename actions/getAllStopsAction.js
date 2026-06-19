import db from "../connections/timetableSqliteDb.js";
import { escapeHtml } from "../utils/appHelpers.js";

export default async (req, res, next) => {
  const longCacheAgeSeconds = 30 * 24 * 3600;
  const stopsRaw = db
    .getCollection("stops")
    .chain()
    .find({})
    .simplesort("code")
    .data();
  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${longCacheAgeSeconds}`)
    .set("Cache-Tag", "long");

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
</style>
</head>
<body>
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

      result += `<tr>
            <td><a target="blank" href="https://lad.lviv.ua/stops/${s.code}">${s.code}</a> (${s.microgiz_id})</td>
            <td>
                <a target="blank" href="https://offline.lad.lviv.ua/${s.code}">SVG</a>
                &nbsp;
                <a target="blank" href="https://pdf.lad.lviv.ua/${s.code}.pdf">PDF</a>
            </td>
            <td>${escapeHtml(s.name)}</td>
            <td><a target="blank" href="https://www.openstreetmap.org/?mlat=${loc[0]}&mlon=${loc[1]}#map=18/${loc[0]}/${loc[1]}">${loc[0]}, ${loc[1]}</a></td>
            <td>${transfers.map(escapeHtml).join(" ")}</td>
            </tr>`;
    }
    result += "</table>\n</body>\n</html>";

    res.send(result);
  }
};
