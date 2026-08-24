import db from "../connections/timetableSqliteDb.js";
import {
  contactBannerHtml,
  contactBannerStyle,
  escapeHtml,
  routeNameToUrlFriendly,
  shapes_by_direction,
} from "../utils/appHelpers.js";

export default async (req, res, next) => {
  // Tagged "short" so the post-deploy cache drop in cloudbuild.yaml purges it:
  // this listing changes whenever a GTFS import adds or removes a route, and a
  // "long"-tagged copy survived deploys for up to the full 30 days.
  const cacheAgeSeconds = 30 * 24 * 3600;
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

  // One pass over stops: `stopByCode` serves the per-row lookups below, and
  // `stopGeo` is the same data shipped to the browser for the comparison maps.
  // Sharing the source is what keeps client-side stop lists identical to what
  // this file used to render.
  const stopByCode = new Map(
    db
      .getCollection("stops")
      .find({
        code: {
          $in: [
            ...new Set(
              routesRaw.flatMap((r) => Object.values(r.stops_by_shape).flat()),
            ),
          ],
        },
      })
      .map((s) => [s.code, s]),
  );
  // Coordinates are [lat, lng] throughout this codebase, despite the GeoJSON
  // -looking `type: "Point"` on the stop docs. Leaflet wants them in that order.
  const stopGeo = Object.fromEntries(
    [...stopByCode].map(([code, s]) => [
      code,
      [s.location.coordinates[0], s.location.coordinates[1], s.name],
    ]),
  );
  // Same expression as the similarity sets below, so the client-side
  // intersection cannot drift from the percentages rendered here.
  const routeStops = routesRaw.map((r) => Object.values(r.stops_by_shape));
  const routeNames = routesRaw.map((r) => r.short_name);

  // Stop sets per route (union of both directions), used for similarity below.
  const stopSets = routeStops.map((dirs) => new Set(dirs.flat()));

  // Top-5 similar routes per route, by Jaccard similarity of shared stops.
  // Only the score is rendered server-side; the shared stop list itself is
  // rebuilt in the browser by `sharedCodes` when a route is expanded.
  const similarRoutes = stopSets.map((set, i) => {
    const scores = [];
    for (let j = 0; j < stopSets.length; j++) {
      if (j === i || !stopSets[j].size) continue;
      let shared = 0;
      for (const code of set) if (stopSets[j].has(code)) shared++;
      if (!shared) continue;
      const union = set.size + stopSets[j].size - shared;
      scores.push({ j, pct: (shared / union) * 100 });
    }
    scores.sort((a, b) => b.pct - a.pct);
    return scores.slice(0, 5);
  });

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
table td:first-child { width: 360px; }
a { text-decoration: none; }
.route-map { width: 320px; height: 500px; }
.route-map:fullscreen, .route-map:-webkit-full-screen { width: 100vw; height: 100vh; }
td.map-cell { padding-bottom: 15px; }
.dir-btns { margin-bottom: 4px; display: flex; gap: 4px; }
.dir-btns button {
  padding: 2px 8px; font-size: 12px; cursor: pointer;
  border: 1px solid #ccc; border-radius: 3px; background: #f5f5f5;
}
.dir-btns button.active { background: #dbeafe; border-color: #2563eb; font-weight: bold; }
.similar-routes { font-size: 11px; color: #666; margin-top: 6px; }
.similar-routes ol { margin: 2px 0 0; padding-left: 18px; }
.similar-routes ul { margin: 2px 0 4px; padding-left: 16px; }
.similar-routes summary { cursor: pointer; }
.cmp-map { width: 300px; height: 260px; margin: 4px 0; }
.cmp-map:fullscreen, .cmp-map:-webkit-full-screen { width: 100vw; height: 100vh; }
.cmp-legend {
  background: rgba(255,255,255,.85); padding: 2px 5px; border-radius: 3px;
  font: 11px/1.4 system-ui, sans-serif; color: #111;
}
.cmp-legend i {
  display: inline-block; width: 10px; height: 10px;
  margin-right: 4px; vertical-align: -1px;
}
.cmp-fullscreen-btn {
  background: #fff; width: 28px; height: 28px; line-height: 28px;
  text-align: center; cursor: pointer; font-size: 15px; border-radius: 3px;
  box-shadow: 0 1px 4px rgba(0,0,0,.4);
}
.split-dot {
  width: 12px; height: 12px; border-radius: 50%;
  background: linear-gradient(90deg, #2563EB 50%, #DC2626 50%);
  border: 1px solid #fff; box-shadow: 0 0 2px rgba(0,0,0,.5);
}
.ab-marker { background: none; border: none; }
.ab-pin {
  width: 22px; height: 22px; line-height: 22px;
  border-radius: 50%; background: rgba(17,17,17,.55); color: #fff;
  text-align: center; font-weight: bold; font-size: 13px;
  border: 2px solid rgba(255,255,255,.7); box-shadow: 0 0 3px rgba(0,0,0,.4);
}
${contactBannerStyle()}
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

// --- Similar-routes comparison maps (kept separate from _maps/_layers above,
// which showDirs assumes hold exactly two direction layers each) ---
var _cmpMaps = {};
var CMP_C = ['#2563EB', '#DC2626'];

// Reproduces the server's similarity ordering exactly: walk route i's own
// stops (dir 0 first, in the order Object.values(stops_by_shape) yields),
// dedupe with a Set before checking membership, keep only codes route j also
// has and that resolve to a known stop. Mirrors the union/shared logic used
// to score similarRoutes server-side.
function sharedCodes(i, j) {
  var a = (_routeStops && _routeStops[i]) || [];
  var b = (_routeStops && _routeStops[j]) || [];
  var inB = new Set(), seen = new Set(), out = [];
  for (var k = 0; k < b.length; k++) {
    var db_ = b[k] || [];
    for (var n = 0; n < db_.length; n++) inB.add(db_[n]);
  }
  for (k = 0; k < a.length; k++) {
    var da = a[k] || [];
    for (n = 0; n < da.length; n++) {
      var c = da[n];
      if (seen.has(c)) continue;
      seen.add(c);
      if (inB.has(c) && _stopGeo[c]) out.push(c);
    }
  }
  return out;
}

function sharedList(codes) {
  var ul = document.createElement('ul');
  codes.forEach(function(c) {
    var g = _stopGeo[c];
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.target = '_blank';
    a.href = 'https://lad.lviv.ua/' + c;
    a.textContent = c;
    li.appendChild(document.createTextNode(g[2] + ' ('));
    li.appendChild(a);
    li.appendChild(document.createTextNode(')'));
    ul.appendChild(li);
  });
  return ul;
}

function splitDotIcon() {
  return L.divIcon({
    className: 'split-dot',
    html: '',
    iconSize: [12, 12], iconAnchor: [6, 6],
  });
}

function addFullscreenControl(m, div, key) {
  var ctl = L.control({ position: 'topright' });
  ctl.onAdd = function() {
    var btn = L.DomUtil.create('div', 'cmp-fullscreen-btn');
    btn.innerHTML = '⛶';
    btn.title = 'На весь екран';
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, 'click', function() {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (div.requestFullscreen) {
        div.requestFullscreen();
      }
    });
    return btn;
  };
  ctl.addTo(m);
  // Comparison maps are destroyed and rebuilt on every reopen, but the div is
  // reused — bind this listener once per div, ever, and resolve the live map
  // through the registry so a rebuilt map is always the one invalidated.
  if (div._fsBound) return;
  div._fsBound = true;
  div.addEventListener('fullscreenchange', function() {
    setTimeout(function() {
      var live = key ? _cmpMaps[key] : m;
      if (live) live.invalidateSize();
    }, 50);
  });
}

function cmpMap(div, key, i, j) {
  if (_cmpMaps[key]) { _cmpMaps[key].invalidateSize(); return; }
  var m = L.map(div, { zoomControl: false, attributionControl: false, preferCanvas: true });
  // Valid view before any layer is added, so nothing can throw regardless of
  // the container's layout state at this point (it just became visible).
  m.setView([49.8397, 24.0297], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(m);
  addFullscreenControl(m, div, key);

  // Each stop is drawn once even though it may belong to both routes' stop
  // lists (every shared stop does) — otherwise the split dot below would be
  // painted twice, once per route, hiding the coloring underneath.
  var shared = new Set(sharedCodes(i, j)), pts = [], stops = new Map();
  [i, j].forEach(function(ri, n) {
    (_routeStops[ri] || []).forEach(function(codes) {
      var line = [];
      (codes || []).forEach(function(c) {
        var g = _stopGeo[c];
        if (!g) return;
        var ll = [g[0], g[1]];
        line.push(ll); pts.push(ll);
        if (!stops.has(c)) stops.set(c, { ll: ll, name: g[2] });
      });
      if (line.length > 1) L.polyline(line, { color: CMP_C[n], weight: n ? 2 : 3, opacity: 0.8 }).addTo(m);
    });
  });

  stops.forEach(function(s, c) {
    var tip = s.name + ' (' + c + ')';
    if (shared.has(c)) {
      L.marker(s.ll, { icon: splitDotIcon(), interactive: true }).bindTooltip(tip).addTo(m);
    } else {
      L.circleMarker(s.ll, {
        radius: 3, color: '#999', weight: 1, fillColor: '#999', fillOpacity: 0.7,
      }).bindTooltip(tip).addTo(m);
    }
  });

  var lg = L.control({ position: 'bottomleft' });
  lg.onAdd = function() {
    var d = L.DomUtil.create('div', 'cmp-legend');
    [i, j].forEach(function(ri, n) {
      var row = L.DomUtil.create('div', '', d);
      L.DomUtil.create('i', '', row).style.background = CMP_C[n];
      row.appendChild(document.createTextNode(_routeNames[ri]));
    });
    L.DomEvent.disableClickPropagation(d);
    return d;
  };
  lg.addTo(m);

  _cmpMaps[key] = m;
  requestAnimationFrame(function() {
    m.invalidateSize();
    if (pts.length) m.fitBounds(pts, { padding: [10, 10], maxZoom: 16 });
  });
}

function cmpDrop(key) {
  var m = _cmpMaps[key];
  if (!m) return;
  // Don't tear the map out from under a still-fullscreen container — that
  // strands the browser in fullscreen showing a dead element.
  if (document.fullscreenElement === m.getContainer()) document.exitFullscreen();
  m.remove();
  delete _cmpMaps[key];
}

function simExpand(el, i, j) {
  var key = i + '-' + j;
  if (!el.open) { cmpDrop(key); return; }
  if (!window._routeStops || !window._stopGeo) return;
  var body = el.lastElementChild;
  if (!el.dataset.built) {
    el.dataset.built = '1';
    var div = document.createElement('div');
    div.className = 'cmp-map';
    body.appendChild(div);
    body.appendChild(sharedList(sharedCodes(i, j)));
  }
  cmpMap(body.firstElementChild, key, i, j);
}
</script>
</head>
<body>
${contactBannerHtml("routes")}
<table>
`;
  for (let [i, r] of routesRaw.entries()) {
    const allStops = {};
    for (const code of stopSets[i]) {
      if (stopByCode.has(code)) allStops[code] = stopByCode.get(code);
    }

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
        `addFullscreenControl(m,document.getElementById('${mapId}'));` +
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

    // The shared-stop list itself is built client-side (see `sharedCodes` /
    // `simExpand` in the head script) when a route is expanded, along with a
    // comparison map — keeping this HTML free of the full stop lists saves
    // hundreds of KB across all routes.
    const similarHtml = similarRoutes[i].length
      ? `<div class="similar-routes">Схожі:<ol>${similarRoutes[i]
          .map(
            (s) =>
              `<li><details ontoggle="simExpand(this,${i},${s.j})"><summary>${escapeHtml(routeNames[s.j])} (${s.pct.toFixed(0)}%)</summary><div class="sim-body"></div></details></li>`,
          )
          .join("")}</ol></div>`
      : "";

    result += `<tr>
        <td><a target="_blank" href="https://lad.lviv.ua/route/${routeNameToUrlFriendly(r.short_name)}">${escapeHtml(r.short_name)}</a> (${r.external_id})${similarHtml}</td>
        <td>${escapeHtml(r.long_name)}</td>
        <td><ol>${stopsByShape[0]}</ol></td>
        <td><ol>${stopsByShape[1]}</ol></td>
        <td class="map-cell">${mapControls}<div id="${mapId}" class="route-map"></div></td>
        </tr>`;
  }
  // Data for the comparison maps, embedded once for all routes. Escaping `<`
  // (and the two Unicode line separators, for older JS engines) is what keeps
  // a stop or route name from ever breaking out of this inline <script>; do
  // NOT run escapeHtml on this JSON, it would corrupt names that are only
  // ever inserted into the DOM via textContent, never via innerHTML.
  const jsonForScript = (v) =>
    JSON.stringify(v)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");

  result +=
    `</table><script>` +
    `var _stopGeo=${jsonForScript(stopGeo)},` +
    `_routeStops=${jsonForScript(routeStops)},` +
    `_routeNames=${jsonForScript(routeNames)};\n` +
    `${mapInits.join("\n")}<\/script>\n</body>\n</html>`;

  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${cacheAgeSeconds}`)
    .set("Cache-Tag", "short")
    .send(result);
};
