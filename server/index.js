try { require('dotenv').config(); } catch {}
const path = require('path'), http = require('http'), express = require('express');
const { Server } = require('socket.io');
const C = require('./config'), E = require('./engine');
const app = express(), server = http.createServer(app), io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const getJSON = async (u, ms = 6000) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'CityPulse-demo/1.0' } });
  if (!r.ok) throw new Error(r.status);
  return r.json();
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = () => Math.random() - 0.5, ease = (c, t, k) => c + (t - c) * k;
const flip = (v, max) => (Math.random() < 0.06 ? clamp(v + (Math.random() < 0.5 ? -1 : 1), 0, max) : v);
const BS = [42, 40, 44, 38, 41, 43, 39, 45, 37, 41, 39, 43]; // each area has its own normal traffic speed
const hav = (a, b) => { const t = (x) => (x * Math.PI) / 180, h = Math.sin(t(b[0] - a[0]) / 2) ** 2 + Math.cos(t(a[0])) * Math.cos(t(b[0])) * Math.sin(t(b[1] - a[1]) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };

let ctx, zones = [], feeds, overrides, analyses = [], alerts, active, summaries, history, live, reports;

// ---------- context: a whole city (12 areas) OR a route (points along the road) ----------
function setContext(c) {
  ctx = c; overrides = {}; alerts = []; active = {}; summaries = {}; history = []; live = {}; analyses = []; reports = {};
  feeds = Object.fromEntries(['weather', 'traffic', 'incidents', 'transit'].map((k) => [k, { last: Date.now(), source: 'demo data', stalled: false }]));
  zones = c.points.map((cfg, i) => {
    const bs = BS[i % BS.length];
    return { cfg, bs, raw: {}, sim: null, hist: { speed: [bs - 1, bs, bs + 1, bs, bs - 1, bs + 1, bs, bs + 2, bs - 1], inc: [1, 0, 1, 1, 0, 1, 1, 0, 1], tension: [15, 18, 16, 20, 17, 19, 16, 18, 17] } };
  });
  io.emit('context', pubCtx());
  pullLive(); tick();
}
const pubCtx = () => ({ mode: ctx.mode, title: ctx.title, info: ctx.info, radiusM: ctx.radiusM, route: ctx.route || null });

// 1 centre + N ring points, split into an inner ring and an outer ring (12 areas by default).
function cityPoints(c) {
  const total = C.areasPerCity, ring2 = Math.floor((total - 1) / 2), ring1 = total - 1 - ring2;
  const cos = Math.cos((c.lat * Math.PI) / 180);
  const rBase = c.population > 5e6 ? 0.07 : c.population > 1e6 ? 0.045 : 0.024;
  const D = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'];
  const pts = [{ name: 'Central area', latitude: c.lat, longitude: c.lon }];
  const ring = (n, rDeg, tag) => Array.from({ length: n }, (_, i) => {
    const b = (360 / n) * i, r = (b * Math.PI) / 180;
    return { name: `${D[Math.round(b / 45) % 8]} ${tag}`, latitude: c.lat + rDeg * Math.cos(r), longitude: c.lon + (rDeg * Math.sin(r)) / cos };
  });
  pts.push(...ring(ring1, rBase, 'side'), ...ring(ring2, rBase * 1.8, 'outskirts'));
  return { points: pts.map((p, i) => ({ ...p, zoneId: `Z${i + 1}` })), radiusM: Math.round(rBase * 111000 * 0.4) };
}
// Try to replace "North side" etc. with real neighbourhood names (OpenStreetMap). Falls back silently.
async function nameZones(mine, pts) {
  for (const p of pts.slice(1)) {
    await new Promise((r) => setTimeout(r, 1100));
    if (ctx !== mine) return;
    try {
      const a = (await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${p.latitude}&lon=${p.longitude}`, 5000)).address || {};
      const n = a.suburb || a.neighbourhood || a.city_district || a.quarter || a.village || a.town;
      if (n && !pts.some((x) => x.name === n)) p.name = n;
    } catch {}
  }
}

// ---------- data: real weather + air quality, demo traffic/incidents/transit/tension ----------
// Weather: OpenWeatherMap first if a key is set (per the spec), otherwise Open-Meteo. Air quality is always Open-Meteo.
async function pullLive() {
  const zs = zones; if (!zs.length) return;
  const key = process.env.OPENWEATHER_API_KEY;
  if (key) {
    const results = await Promise.allSettled(zs.map((z) => getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${z.cfg.latitude}&lon=${z.cfg.longitude}&units=metric&appid=${key}`, 6000)));
    if (zs !== zones) return;
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    if (ok >= zs.length * 0.6) {
      results.forEach((r, i) => { if (r.status === 'fulfilled') { const w = r.value; Object.assign((live[zs[i].cfg.zoneId] ||= {}), { temp: w.main.temp, wind: w.wind.speed * 3.6, rain: (w.rain?.['1h'] ?? 0) }); } });
      feeds.weather.source = 'real data (OpenWeatherMap)';
    } else await pullOpenMeteo(zs); // rate-limited or key invalid: fall back
  } else await pullOpenMeteo(zs);
  try {
    const la = zs.map((z) => z.cfg.latitude.toFixed(3)).join(), lo = zs.map((z) => z.cfg.longitude.toFixed(3)).join();
    const j = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${la}&longitude=${lo}&current=us_aqi`);
    (Array.isArray(j) ? j : [j]).forEach((x, i) => zs[i] && (live[zs[i].cfg.zoneId] ||= {}) && (live[zs[i].cfg.zoneId].aqi = x.current.us_aqi));
  } catch {}
}
async function pullOpenMeteo(zs) {
  try {
    const la = zs.map((z) => z.cfg.latitude.toFixed(3)).join(), lo = zs.map((z) => z.cfg.longitude.toFixed(3)).join();
    const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,wind_speed_10m,rain`);
    (Array.isArray(j) ? j : [j]).forEach((x, i) => zs[i] && Object.assign((live[zs[i].cfg.zoneId] ||= {}), { temp: x.current.temperature_2m, wind: x.current.wind_speed_10m, rain: x.current.rain || 0 }));
    feeds.weather.source = 'real data (Open-Meteo)';
  } catch { feeds.weather.source = 'demo data'; }
}

// Cascading effect: a verified unplanned power outage drops traffic speed (dead signals) and raises tension,
// the same way one civic problem can spread into others in real life. Planned maintenance does none of this.
function simulate(z) {
  const id = z.cfg.zoneId, o = overrides[id] || {}, L = live[id] || {};
  const s = z.sim || (z.sim = { speed: z.bs, delay: 5, water: 0, acc: 0, other: 1, tension: 15, power: 'normal', water_u: 'normal' });
  const outage = o.power === 'outage-unplanned';
  const cascadeSpeed = outage ? z.bs * 0.55 : z.bs;
  const cascadeTension = outage ? 70 : (o.tension ?? 15);
  s.speed = o.speed !== undefined ? o.speed + rnd() * 0.6 : ease(s.speed, cascadeSpeed, 0.3) + rnd() * 0.4;
  s.delay = o.delay !== undefined ? o.delay + rnd() * 0.6 : ease(s.delay, outage ? 14 : 5, 0.3) + rnd() * 0.3;
  s.tension = o.tension !== undefined || outage ? ease(s.tension, cascadeTension, 0.4) + rnd() * 2 : ease(s.tension, 15, 0.2) + rnd() * 1.5;
  s.tension = clamp(s.tension, 0, 100);
  s.water = o.water ?? flip(Math.min(s.water, 1), 1); s.acc = o.acc ?? flip(Math.min(s.acc, 1), 1); s.other = flip(s.other, 2);
  s.power = o.power || 'normal'; s.water_u = o.water_u || 'normal';
  const mk = (type, n) => Array.from({ length: n }, () => ({ type, severity: n > 4 ? 'high' : 'low' })); // no personal data
  return {
    weather: { precip_mm_h: +(o.rain ?? L.rain ?? 0).toFixed(1), temp_c: Math.round(L.temp ?? 30), wind_kmh: Math.round(o.wind ?? L.wind ?? 12), aqi: Math.round(o.aqi ?? L.aqi ?? 80) },
    traffic: { avg_speed_kmh: Math.round(s.speed) },
    incidents: [...mk('waterlogging', s.water), ...mk('accident', s.acc), ...mk('other', s.other)],
    transit: { avg_delay_min: Math.max(0, Math.round(s.delay)) },
    tension: s.tension,
    utility: { power: s.power, water: s.water_u },
  };
}

// ---------- crowdsourced reports: consensus over a rolling window, spam-resistant ----------
// One report is logged but changes nothing. Enough reports of the same type, in the same area,
// within the window, get treated as verified and (for power/water) trigger the cascade above.
function fileReport(zoneId, type) {
  const z = zones.find((x) => x.cfg.zoneId === zoneId);
  if (!z) return { error: 'Unknown area' };
  const now = Date.now(), key = `${zoneId}:${type}`;
  const list = (reports[key] = (reports[key] || []).filter((t) => now - t < C.report.windowMs));
  list.push(now);
  const verified = list.length >= C.report.threshold;
  if (verified && (type === 'power-outage' || type === 'water-outage')) {
    const field = type === 'power-outage' ? 'power' : 'water_u';
    overrides[zoneId] = { ...overrides[zoneId], [field]: 'outage-unplanned' };
  }
  return { ok: true, count: list.length, needed: C.report.threshold, verified, windowMinutes: C.report.windowMs / 60000 };
}

// ---------- summaries (Gemini if key present, else template) ----------
async function summarize(a) {
  const sig = Object.keys(a.signals).join() + a.reading.utility.power;
  if (summaries[a.zoneId]?.sig === sig) return;
  summaries[a.zoneId] = { sig, text: E.templateSummary(a), source: 'template' };
  if (!process.env.GEMINI_API_KEY || (!a.count && a.reading.utility.power === 'normal')) return;
  const data = { place: a.name, rain: a.reading.weather.rain, incidents: a.reading.incidents.total, waterlogging: a.reading.incidents.waterlogging, transitDelayMin: a.reading.transit.delay, trafficSpeed: a.reading.traffic.averageSpeed, usualSpeed: a.baseline.speed, tension: a.reading.tension.value, power: a.reading.utility.power, unusual: Object.keys(a.signals) };
  const prompt = `Generate a concise civic summary using ONLY the provided data.\nDo not invent facts. Do not claim causation.\nUse simple everyday words. Prefer: "at the same time", "may be connected".\nMaximum 2 sentences.\nDATA: ${JSON.stringify(data)}`;
  try {
    const m = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000), body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
    const text = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (text && text.length < 400 && !/\b(caused|because of|due to)\b/i.test(text)) summaries[a.zoneId] = { sig, text, source: 'ai' };
  } catch {}
}
function updateAlerts(a) {
  const rule = E.alertRule(a), cur = active[a.zoneId];
  if (cur && (!rule || rule.type !== cur.type)) { cur.status = 'resolved'; delete active[a.zoneId]; }
  if (rule && !active[a.zoneId]) { const al = { id: `${a.zoneId}-${Date.now()}`, zoneId: a.zoneId, zone: a.name, ...rule, ts: new Date().toISOString(), status: 'active' }; active[a.zoneId] = al; alerts.unshift(al); alerts = alerts.slice(0, 30); }
  else if (rule) active[a.zoneId].evidence = rule.evidence;
}

// ---------- pipeline ----------
function tick() {
  if (!zones.length) return;
  const now = Date.now();
  for (const k in feeds) if (!feeds[k].stalled) feeds[k].last = now;
  const fresh = Object.fromEntries(Object.entries(feeds).map(([k, f]) => [k, now - f.last < C.staleMs]));
  analyses = zones.map((z) => {
    const sim = simulate(z);
    for (const k in feeds) if (!feeds[k].stalled) z.raw[k] = sim[k];
    if (!z.raw.weather) z.raw = sim;
    z.raw.tension = sim.tension; z.raw.utility = sim.utility;
    const a = E.analyze(z, E.normalize(z.cfg.zoneId, z.raw), fresh);
    Object.assign(a, { routeIndex: z.cfg.routeIndex, cumKm: z.cfg.cumKm });
    updateAlerts(a); summarize(a);
    return a;
  });
  history = [...history, { ts: new Date().toISOString(), health: Math.round(E.avg(analyses.map((a) => a.health))) }].slice(-300);
  io.emit('state', buildState());
}
const feedStatus = () => Object.fromEntries(Object.entries(feeds).map(([k, f]) => { const age = Math.round((Date.now() - f.last) / 1000), ok = age * 1000 < C.staleMs; return [k, { status: ok ? 'live' : 'delayed', ageSeconds: age, source: f.source }]; }));

function routeCalc() {
  const R = ctx.route; let normal = 0, nowT = 0, worst = { x: 0, txt: '' }, heavy = 0, acc = 0;
  analyses.forEach((a) => { if (a.signals.weather) heavy++; acc += a.reading.incidents.accidents; });
  for (let k = 0; k < analyses.length - 1; k++) {
    const a = analyses[k], b = analyses[k + 1], d = ((b.cumKm - a.cumKm) / R.distanceKm) * R.durationMin;
    const ratio = (a.reading.traffic.averageSpeed / a.baseline.speed + b.reading.traffic.averageSpeed / b.baseline.speed) / 2;
    const f = clamp(1 / Math.max(ratio, 0.1), 1, 3); normal += d; nowT += d * f;
    if (d * (f - 1) > worst.x) worst = { x: d * (f - 1), txt: `km ${Math.round(a.cumKm)} to ${Math.round(b.cumKm)}` };
  }
  const [n, w] = [Math.round(normal), Math.round(nowT)], delay = w - n;
  const text = `${R.distanceKm.toFixed(0)} km trip. Usual drive is about ${n} min; right now about ${w} min${delay >= 2 ? ` (${delay} min longer)` : ' (no big delay)'}.` +
    (worst.x >= 1 ? ` Slowest part: ${worst.txt}.` : '') + (heavy ? ` Heavy rain at ${heavy} of ${analyses.length} points.` : '') + (acc ? ` ${acc} accident report${acc > 1 ? 's' : ''} near the route.` : '');
  return { distanceKm: +R.distanceKm.toFixed(1), normalMin: n, nowMin: w, delayMin: delay, text };
}
// Straight-line commute estimate between any two areas in the current city, using their current traffic speeds.
// This is a simplified as-the-crow-flies estimate, not a turn-by-turn route (use "Route" mode for that).
function commuteCalc(fromId, toId) {
  const a = analyses.find((x) => x.zoneId === fromId), b = analyses.find((x) => x.zoneId === toId);
  if (!a || !b) return { error: 'Unknown area' };
  const km = hav([a.latitude, a.longitude], [b.latitude, b.longitude]) * 1.35; // +35% for a non-straight road
  const speed = (a.reading.traffic.averageSpeed + b.reading.traffic.averageSpeed) / 2;
  const minutes = Math.round((km / Math.max(speed, 5)) * 60);
  const passesTrouble = [a, b].some((z) => z.count >= 2);
  return { fromId, toId, from: a.name, to: b.name, km: +km.toFixed(1), minutes, avgSpeed: Math.round(speed), passesTrouble, note: passesTrouble ? `Heads up: ${(a.count >= 2 ? a.name : b.name)} has multiple unusual signals right now.` : null };
}
function buildState() {
  const n = analyses.length, health = n ? Math.round(E.avg(analyses.map((a) => a.health))) : 0;
  const counts = { healthy: 0, attention: 0, warning: 0, critical: 0 }; analyses.forEach((a) => counts[a.status]++);
  let overview = '', route = null;
  if (n && ctx.mode === 'route') { route = routeCalc(); overview = route.text; }
  else if (n) {
    const bad = analyses.filter((a) => a.status !== 'healthy').sort((a, b) => a.health - b.health);
    overview = bad.length ? `${bad.length} of ${n} areas need attention. Most affected: ${bad[0].name}. ${summaries[bad[0].zoneId].text}` : `${ctx.title} looks good right now. All ${n} areas are normal.`;
  }
  const c = analyses[0]?.reading;
  return { ts: new Date().toISOString(), city: { health, label: health >= 75 ? 'Good' : health >= 55 ? 'Keep an eye' : 'Needs attention', counts, activeAlerts: Object.keys(active).length },
    zones: analyses, alerts, feeds: feedStatus(), summaries, overview, route, now: c && { rain: c.weather.rain, temp: c.weather.temperature, wind: c.weather.wind, aqi: c.aqi.value, real: feeds.weather.source.startsWith('real') },
    history: history.slice(-60) };
}

// ---------- REST ----------
const api = express.Router();
const slice = (k) => (q, r) => r.json(analyses.map((a) => ({ zoneId: a.zoneId, name: a.name, ...a.reading[k] })));
api.get('/zones', (q, r) => r.json(zones.map((z) => z.cfg)));
['weather', 'traffic', 'incidents', 'transit'].forEach((k) => api.get('/' + k, slice(k)));
api.get('/health', (q, r) => r.json(analyses.map((a) => ({ zoneId: a.zoneId, name: a.name, health: a.health, status: a.status, factors: a.factors }))));
api.get('/alerts', (q, r) => r.json(alerts));
api.get('/correlations', (q, r) => r.json(analyses.filter((a) => a.count).map((a) => ({ zoneId: a.zoneId, name: a.name, signals: a.signals, count: a.count, correlationScore: a.corrScore }))));
api.get('/summary/:zoneId', (q, r) => (summaries[q.params.zoneId] ? r.json(summaries[q.params.zoneId]) : r.status(404).json({ error: 'Unknown area' })));
api.get('/history', (q, r) => r.json(history));
api.get('/feed-status', (q, r) => r.json(feedStatus()));
api.get('/commute', (q, r) => { const j = commuteCalc(q.query.from, q.query.to); j.error ? r.status(404).json(j) : r.json(j); });

// Citizen reports: no names, phone numbers, addresses or accounts are stored, only area + type + timestamp.
api.post('/report', (q, r) => {
  const { zoneId, type } = q.body || {};
  const ok = ['waterlogging', 'accident', 'power-outage', 'water-outage', 'other'].includes(type);
  if (!zoneId || !ok) return r.status(400).json({ error: 'Give a valid area and issue type.' });
  const result = fileReport(zoneId, type); if (result.error) return r.status(404).json(result);
  if (result.verified) tick(); r.json(result);
});

const cache = new Map();
async function geocode(q) {
  const key = q.toLowerCase(); if (cache.has(key)) return cache.get(key);
  let out = [], err;
  for (let t = 0; t < 2 && !out.length; t++) { // 1) Open-Meteo geocoding (retry once)
    try {
      const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en`, 8000);
      out = (j.results || []).map((p) => ({ name: p.name, region: p.admin1 || '', country: p.country || '', lat: p.latitude, lon: p.longitude, population: p.population || null, timezone: p.timezone, elevation: p.elevation }));
      err = null; break;
    } catch (e) { err = e; }
  }
  if (!out.length) { // 2) fallback: OpenStreetMap Nominatim (finds towns, areas and small places too)
    try {
      const j = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`, 8000);
      out = j.map((p) => ({ name: p.name || p.display_name.split(',')[0], region: p.address?.state || p.address?.county || '', country: p.address?.country || '', lat: +p.lat, lon: +p.lon, population: null, timezone: null })); err = null;
    } catch (e) { err = err || e; }
  }
  if (err && !out.length) throw err;
  cache.set(key, out); return out;
}
api.get('/search', async (q, r) => {
  try { r.json(await geocode(String(q.query.q || '').trim())); }
  catch (e) { console.error('Search failed:', e.message); r.status(502).json({ error: 'Search could not reach the internet from the server. Check your connection and try again.' }); }
});
// Nearest area to a GPS point (used by the "Find my area" button, which reads the browser's location).
api.get('/nearest', (q, r) => {
  const lat = +q.query.lat, lon = +q.query.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !analyses.length) return r.status(400).json({ error: 'No location or no active city.' });
  let best = null, bestD = Infinity;
  analyses.forEach((a) => { const d = hav([lat, lon], [a.latitude, a.longitude]); if (d < bestD) { bestD = d; best = a; } });
  r.json({ zoneId: best.zoneId, name: best.name, distanceKm: +bestD.toFixed(1), health: best.health, status: best.status });
});
api.post('/city', (q, r) => {
  const c = q.body || {};
  if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return r.status(400).json({ error: 'Pick a place from the list.' });
  const { points, radiusM } = cityPoints(c);
  setContext({ mode: 'city', title: c.name, info: { region: c.region, country: c.country, population: c.population, timezone: c.timezone, elevation: c.elevation }, radiusM, points });
  nameZones(ctx, points); r.json({ ok: true });
});
api.post('/route', async (q, r) => {
  const { from: a, to: b } = q.body || {};
  if (![a?.lat, a?.lon, b?.lat, b?.lon].every(Number.isFinite)) return r.status(400).json({ error: 'Pick both places from the list.' });
  try {
    const rt = (await getJSON(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`, 12000)).routes?.[0];
    if (!rt) throw new Error('none');
    const co = rt.geometry.coordinates, st = Math.ceil(co.length / 400);
    const g = co.filter((_, i) => i % st === 0 || i === co.length - 1).map((c) => [c[1], c[0]]);
    const cum = [0]; for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + hav(g[i - 1], g[i]));
    const total = cum[cum.length - 1] || 1, km = rt.distance / 1000, N = clamp(Math.round(km / 4) + 2, 3, 7);
    const points = Array.from({ length: N }, (_, i) => {
      let idx = i === N - 1 ? g.length - 1 : Math.max(0, cum.findIndex((x) => x >= (total * i) / (N - 1)));
      const cumKm = (cum[idx] / total) * km;
      return { zoneId: `Z${i + 1}`, name: i === 0 ? 'Start' : i === N - 1 ? 'End' : `About ${Math.round(cumKm)} km in`, latitude: g[idx][0], longitude: g[idx][1], routeIndex: idx, cumKm };
    });
    setContext({ mode: 'route', title: `${a.name} to ${b.name}`, info: {}, radiusM: 350, route: { distanceKm: km, durationMin: rt.duration / 60, geometry: g }, points });
    r.json({ ok: true });
  } catch { r.status(502).json({ error: 'Could not find a road route between these places.' }); }
});

const target = (w) => zones[ctx.mode === 'route' ? (w === 0 ? Math.floor(zones.length / 2) : Math.max(0, zones.length - 2)) : w % zones.length];
api.post('/simulation/heavy-rain', (q, r) => { const z = target(0); overrides[z.cfg.zoneId] = { ...overrides[z.cfg.zoneId], rain: 25, speed: Math.round(z.bs * 0.57), water: 8, delay: 21, wind: 28 }; tick(); r.json({ ok: true, message: `Heavy rain demo started in ${z.cfg.name}` }); });
api.post('/simulation/traffic-incident', (q, r) => { const z = target(1); overrides[z.cfg.zoneId] = { ...overrides[z.cfg.zoneId], speed: 9, acc: 4, delay: 17 }; tick(); r.json({ ok: true, message: `Traffic accident demo started in ${z.cfg.name}` }); });
api.post('/simulation/crowd-surge', (q, r) => { const z = target(2); overrides[z.cfg.zoneId] = { ...overrides[z.cfg.zoneId], tension: 85 }; tick(); r.json({ ok: true, message: `Crowd/tension spike demo started in ${z.cfg.name}` }); });
api.post('/simulation/power-outage/:mode', (q, r) => {
  const mode = q.params.mode === 'planned' ? 'outage-planned' : 'outage-unplanned', z = target(3);
  overrides[z.cfg.zoneId] = { ...overrides[z.cfg.zoneId], power: mode };
  tick();
  r.json({ ok: true, message: mode === 'outage-planned' ? `Planned maintenance demo started in ${z.cfg.name}. This does not lower its score.` : `Unplanned grid failure demo started in ${z.cfg.name}. Watch traffic and public mood react.` });
});
api.post('/simulation/reset', (q, r) => { overrides = {}; reports = {}; Object.values(feeds).forEach((f) => (f.stalled = false)); tick(); r.json({ ok: true, message: 'Demo reset. Numbers will settle back to normal.' }); });
api.post('/simulation/outage/:feed', (q, r) => { const f = feeds[q.params.feed]; if (!f) return r.status(404).json({ error: 'Unknown feed' }); f.stalled = !f.stalled; r.json({ ok: true, message: f.stalled ? 'Transit updates stopped. It will show OLD DATA in about 45 seconds.' : 'Transit updates are back.' }); });
app.use('/api', api);
app.use((err, q, r, n) => r.status(500).json({ error: 'Something went wrong' }));

io.on('connection', (s) => { s.emit('context', pubCtx()); s.emit('state', buildState()); });
const start = { name: 'Jaipur', lat: 26.9124, lon: 75.7873, population: 3073350, region: 'Rajasthan', country: 'India', timezone: 'Asia/Kolkata' };
const cp = cityPoints(start);
setContext({ mode: 'city', title: start.name, info: { region: start.region, country: start.country, population: start.population, timezone: start.timezone }, radiusM: cp.radiusM, points: cp.points });
setInterval(tick, C.tickMs); setInterval(pullLive, 300000);
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`CityPulse running at http://localhost:${PORT}`));
