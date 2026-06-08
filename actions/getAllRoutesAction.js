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
.route-pb { height: 3px; width: 320px; background: #e5e7eb; }
.route-pb-inner { height: 100%; width: 0%; background: #2563EB; }
</style>
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
    if (shapes[0] || shapes[1]) {
      mapInits.push(
        `(function(){var m=L.map('${mapId}',{zoomControl:false,attributionControl:false});` +
        `L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(m);` +
        `var s=${JSON.stringify([shapes[0] ?? null, shapes[1] ?? null])};` +
        `var c=['#2563EB','#DC2626'],pts=[];` +
        `s.forEach(function(sh,i){if(sh&&sh.length){L.polyline(sh,{color:c[i],weight:3}).addTo(m);pts=pts.concat(sh);}});` +
        `if(pts.length)m.fitBounds(pts);` +
        `window._rm=window._rm||{};window._rm[${JSON.stringify(r.short_name)}]={map:m,markers:L.layerGroup().addTo(m),pb:document.getElementById('pb-${mapId}')};})();`,
      );
    }

    result += `<tr>
        <td><a target="_blank" href="https://lad.lviv.ua/route/${r.short_name}">${escapeHtml(r.short_name)}</a></td>
        <td>${escapeHtml(r.long_name)}</td>
        <td><ol>${stopsByShape[0]}</ol></td>
        <td><ol>${stopsByShape[1]}</ol></td>
        <td class="map-cell"><div id="${mapId}" class="route-map"></div><div class="route-pb"><div id="pb-${mapId}" class="route-pb-inner"></div></div></td>
        </tr>`;
  }
  const vehicleScript =
    `(function(){` +
    `var c=['#2563EB','#DC2626'];` +
    `var rm=window._rm||{};` +
    `var divToName={};` +
    `Object.keys(rm).forEach(function(name){divToName[rm[name].map.getContainer().id]=name;});` +
    `function fetchAndDraw(name){` +
    `var info=rm[name];var pb=info.pb;` +
    `pb.style.transition='none';pb.style.width='40%';pb.style.opacity='0.6';` +
    `fetch('/routes/dynamic/'+encodeURIComponent(name))` +
    `.then(function(r){return r.json();})` +
    `.then(function(vs){` +
    `info.markers.clearLayers();` +
    `vs.forEach(function(v){` +
    `if(!v.location)return;` +
    `L.circleMarker(v.location,{radius:5,color:'#fff',weight:1.5,fillColor:c[v.direction]||'#888',fillOpacity:0.9}).addTo(info.markers);` +
    `});` +
    `pb.style.transition='none';pb.style.width='100%';pb.style.opacity='1';` +
    `setTimeout(function(){pb.style.transition='width 10s linear';pb.style.width='0%';},50);` +
    `}).catch(function(){pb.style.transition='none';pb.style.width='0%';});}` +
    `var obs=new IntersectionObserver(function(entries){` +
    `entries.forEach(function(e){` +
    `var name=divToName[e.target.id];if(!name)return;` +
    `var info=rm[name];` +
    `if(e.isIntersecting){fetchAndDraw(name);info.timer=setInterval(function(){fetchAndDraw(name);},10000);}` +
    `else{clearInterval(info.timer);info.timer=null;}` +
    `});},{threshold:0.1});` +
    `Object.keys(rm).forEach(function(name){obs.observe(rm[name].map.getContainer());});` +
    `})();`;

  result += `</table><script>${mapInits.join("\n")}\n${vehicleScript}<\/script>\n</body>\n</html>`;

  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${longCacheAgeSeconds}`)
    .set("Cache-Tag", "long")
    .send(result);
};
