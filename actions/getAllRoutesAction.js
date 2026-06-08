import db from "../connections/timetableSqliteDb.js";
import { escapeHtml, shapes_by_direction } from "../utils/appHelpers.js";

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

  const mapInits = [];

  let result = `
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
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
        .route-map { width: 320px; height: 500px; }
        td.map-cell { padding-bottom: 15px; }
        </style>
        <table>
    `;
  for (let [i, r] of routesRaw.entries()) {
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

    const shapes = shapes_by_direction(r);
    const mapId = `map-${i}`;
    if (shapes[0] || shapes[1]) {
      mapInits.push(
        `(function(){var m=L.map('${mapId}',{zoomControl:false,attributionControl:false});` +
        `L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(m);` +
        `var s=${JSON.stringify([shapes[0] ?? null, shapes[1] ?? null])};` +
        `var c=['#2563EB','#DC2626'],pts=[];` +
        `s.forEach(function(sh,i){if(sh&&sh.length){L.polyline(sh,{color:c[i],weight:3}).addTo(m);pts=pts.concat(sh);}});` +
        `if(pts.length)m.fitBounds(pts);})();`,
      );
    }

    result += `<tr>
        <td><a target="_blank" href="https://lad.lviv.ua/route/${r.short_name}">${escapeHtml(r.short_name)}</a></td>
        <td>${escapeHtml(r.long_name)}</td>
        <td><ol>${stopsByShape[0]}</ol></td>
        <td><ol>${stopsByShape[1]}</ol></td>
        <td class="map-cell"><div id="${mapId}" class="route-map"></div></td>
        </tr>`;
  }
  result += `</table><script>${mapInits.join("\n")}<\/script>`;

  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${longCacheAgeSeconds}`)
    .set("Cache-Tag", "long")
    .send(result);
};
