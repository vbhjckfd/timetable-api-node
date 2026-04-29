import db from "../connections/timetableSqliteDb.js";
import { escapeHtml } from "../utils/appHelpers.js";

export default async (req, res, next) => {
  const longCacheAgeSeconds = 30 * 24 * 3600;
  const routesRaw = db
    .getCollection("routes")
    .chain()
    .find({})
    .simplesort("short_name")
    .data();

  if (req.path.endsWith(".json")) {
    // Return all data in JSON format
    return res.json(routesRaw);
  }

  let result = `
        <style>
        table {border-collapse: collapse;}
        table, th{
            text-align: left;
        }
        table tr {border-bottom: 1pt solid black;}
        table td {vertical-align: top;}
        a {
            text-decoration: none;
        }
        </style>
        <table>
    `;
  for (let r of routesRaw) {
    const stopsArr = db.getCollection("stops").find({
      code: { $in: Object.values(r.stops_by_shape).flat() },
    });
    const allStops = Object.fromEntries(stopsArr.map((s) => [s.code, s]));

    let stopsByShape = [];
    for (const key of [0, 1]) {
      stopsByShape[key] = r.stops_by_shape[String(key)]
        .filter((st) => !!allStops[st])
        .map((st) => allStops[st])
        .map((s) => ({ code: s.code, name: s.name }))
        .map(
          (s) =>
            `<li>${escapeHtml(s.name)} (<a target="_blank" href="https://lad.lviv.ua/${s.code}">${s.code}</a>)</li>`,
        )
        .join("");
    }

    result += `<tr>
        <td><a target="_blank" href="https://lad.lviv.ua/route/${r.short_name}">${escapeHtml(r.short_name)}</a></td>
        <td>${escapeHtml(r.long_name)}</td>
        <td><ol>${stopsByShape[0]}</ol></td>
        <td><ol>${stopsByShape[1]}</ol></td>
        </tr>`;
  }
  result += "</table>";

  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${longCacheAgeSeconds}`)
    .set("Cache-Tag", "long")
    .send(result);
};
