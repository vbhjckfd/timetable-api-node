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

  const baseUrl = `${req.protocol}://${req.hostname}`;
  const canonical = `${baseUrl}/routes`;
  const title = "Маршрути громадського транспорту Львова";
  const description = "Повний список маршрутів громадського транспорту Львова із зупинками та картами.";

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
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
table {border-collapse: collapse;}
table, th { text-align: left; }
table tr {border-bottom: 1pt solid black;}
table td {vertical-align: top;}
a { text-decoration: none; }
.route-map { width: 320px; height: 500px; }
td.map-cell { padding-bottom: 15px; }
.dir-btns { margin-bottom: 4px; display: flex; gap: 4px; }
.dir-btns button {
  padding: 2px 8px; font-size: 12px; cursor: pointer;
  border: 1px solid #ccc; border-radius: 3px; background: #f5f5f5;
}
.dir-btns button.active { background: #dbeafe; border-color: #2563eb; font-weight: bold; }
.ab-marker { background: none; border: none; }
.ab-pin {
  width: 22px; height: 22px; line-height: 22px;
  border-radius: 50%; background: rgba(17,17,17,.55); color: #fff;
  text-align: center; font-weight: bold; font-size: 13px;
  border: 2px solid rgba(255,255,255,.7); box-shadow: 0 0 3px rgba(0,0,0,.4);
}
</style>
<script>
var _maps = {}, _layers = {};
function abIcon(label) {
  return L.divIcon({
    className: 'ab-marker',
    html: '<div class="ab-pin">' + label + '</div>',
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
}
function showDirs(id, dirs) {
  var m = _maps[id], ls = _layers[id];
  if (!m || !ls) return;
  [0, 1].forEach(function(i) {
    if (!ls[i]) return;
    if (dirs.indexOf(i) >= 0) m.addLayer(ls[i]); else m.removeLayer(ls[i]);
  });
  var btns = document.querySelectorAll('[data-map="' + id + '"]');
  btns.forEach(function(b) {
    b.classList.toggle('active', b.dataset.dirs === dirs.join(','));
  });
}
</script>
</head>
<body>
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

    // Route terminals: A = start, B = end (from dir0, falling back to dir1 reversed).
    const dir0 = r.stops_by_shape["0"] || [];
    const dir1 = r.stops_by_shape["1"] || [];
    const aCode = dir0.length ? dir0[0] : dir1.at(-1);
    const bCode = dir0.length ? dir0.at(-1) : dir1[0];
    const endpoints = [
      ["A", allStops[aCode]],
      ["B", allStops[bCode]],
    ]
      .filter(([, s]) => !!s)
      .map(([label, s]) => ({
        label,
        ll: s.location.coordinates,
        title: `${s.name} (${s.code})`,
      }));

    // Approximate (stop-sequence) shapes are drawn dashed to flag them.
    const syntheticDirs = r.synthetic_shape_dirs || [];

    if (shapes[0] || shapes[1]) {
      mapInits.push(
        `(function(){` +
        `var m=L.map('${mapId}',{zoomControl:false,attributionControl:false});` +
        `L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(m);` +
        `var s=${JSON.stringify([shapes[0] ?? null, shapes[1] ?? null])};` +
        `var c=['#2563EB','#DC2626'],pts=[],ls=[null,null];` +
        `var dash=${JSON.stringify([syntheticDirs.includes(0), syntheticDirs.includes(1)])};` +
        `s.forEach(function(sh,i){if(sh&&sh.length){var o={color:c[i],weight:3};if(dash[i])o.dashArray='6,8';ls[i]=L.polyline(sh,o).addTo(m);pts=pts.concat(sh);}});` +
        `var ep=${JSON.stringify(endpoints)};` +
        `ep.forEach(function(e){L.marker(e.ll,{icon:abIcon(e.label),title:e.title}).addTo(m);pts.push(e.ll);});` +
        `if(pts.length)m.fitBounds(pts);` +
        `_maps['${mapId}']=m;_layers['${mapId}']=ls;})();`,
      );
    }

    const mapControls = (shapes[0] || shapes[1])
      ? `<div class="dir-btns">` +
        `<button data-map="${mapId}" data-dirs="0" onclick="showDirs('${mapId}',[0])">Dir 1</button>` +
        `<button data-map="${mapId}" data-dirs="1" onclick="showDirs('${mapId}',[1])">Dir 2</button>` +
        `<button data-map="${mapId}" data-dirs="0,1" class="active" onclick="showDirs('${mapId}',[0,1])">Both</button>` +
        `</div>`
      : "";

    result += `<tr>
        <td><a target="_blank" href="https://lad.lviv.ua/route/${r.short_name}">${escapeHtml(r.short_name)}</a> (${r.external_id})</td>
        <td>${escapeHtml(r.long_name)}</td>
        <td><ol>${stopsByShape[0]}</ol></td>
        <td><ol>${stopsByShape[1]}</ol></td>
        <td class="map-cell">${mapControls}<div id="${mapId}" class="route-map"></div></td>
        </tr>`;
  }
  result += `</table><script>${mapInits.join("\n")}<\/script>\n</body>\n</html>`;

  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${longCacheAgeSeconds}`)
    .set("Cache-Tag", "long")
    .send(result);
};
