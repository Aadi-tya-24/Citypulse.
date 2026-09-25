const C = require('./config');
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const LEVELS = ['Normal', 'One unusual thing', 'Two things together', 'Three things together', 'Four+ things together'];

const windowOf = (ts) => {
  const s = Math.floor(ts / C.windowMs) * C.windowMs;
  return { start: new Date(s).toISOString(), end: new Date(s + C.windowMs).toISOString() };
};

// Each feed arrives in its own format; this maps them all to the common civic model.
// tension: an anonymous "how upset does this area sound" score (0-100), never tied to any person.
// utility: power/water grid status for this area, set by the simulator (never a real API in this demo).
function normalize(zoneId, raw) {
  const inc = raw.incidents || [];
  const count = (t) => inc.filter((i) => i.type === t).length;
  const water = count('waterlogging'), acc = count('accident');
  return {
    zoneId,
    timestamp: new Date().toISOString(),
    window: windowOf(Date.now()),
    weather: { rain: raw.weather.precip_mm_h, temperature: raw.weather.temp_c, wind: raw.weather.wind_kmh },
    traffic: { averageSpeed: raw.traffic.avg_speed_kmh, congestion: clamp(Math.round(110 - raw.traffic.avg_speed_kmh * 2.6)) },
    transit: { delay: raw.transit.avg_delay_min },
    incidents: { waterlogging: water, accidents: acc, total: inc.length },
    aqi: { value: raw.weather.aqi },
    tension: { value: Math.round(raw.tension ?? 20) },
    utility: raw.utility || { power: 'normal', water: 'normal' },
  };
}

const status = (h) => (h >= 75 ? 'healthy' : h >= 55 ? 'attention' : h >= 35 ? 'warning' : 'critical');
const STATUS_LABEL = { healthy: 'Good', attention: 'Keep an eye', warning: 'Problem', critical: 'Serious problem' };

// Rule-based, transparent anomaly detection against a rolling baseline.
function analyze(z, n, fresh) {
  const T = C.T;
  const baseSpeed = avg(z.hist.speed), baseInc = avg(z.hist.inc), baseTension = avg(z.hist.tension);
  const S = {};
  if (fresh.weather && n.weather.rain > T.rain) S.weather = { label: 'Heavy rain', detail: `${n.weather.rain} mm/h` };
  if (fresh.traffic && n.traffic.averageSpeed < baseSpeed * T.speedRatio)
    S.traffic = { label: 'Slow traffic', detail: `speed down ${Math.round(100 - (n.traffic.averageSpeed / baseSpeed) * 100)}%` };
  if (fresh.incidents && n.incidents.total >= T.incidentMin && n.incidents.total > baseInc * T.incidentMult)
    S.incidents = { label: 'More complaints than usual', detail: `${n.incidents.total} reports (usually about ${Math.round(Math.max(baseInc, 1))})` };
  if (fresh.transit && n.transit.delay > T.delay) S.transit = { label: 'Bus/train delays', detail: `${n.transit.delay} min late` };
  if (n.tension.value > T.tension && n.tension.value > baseTension * 1.4)
    S.tension = { label: 'More people sound upset online', detail: `tension score ${n.tension.value}/100` };
  const keys = Object.keys(S);
  const count = keys.length;
  const corrScore = clamp(keys.reduce((s, k) => s + C.P[k], 0));

  if (!S.traffic) z.hist.speed = [...z.hist.speed, n.traffic.averageSpeed].slice(-30);
  if (!S.incidents) z.hist.inc = [...z.hist.inc, n.incidents.total].slice(-30);
  if (!S.tension) z.hist.tension = [...z.hist.tension, n.tension.value].slice(-30);

  const sub = {
    traffic: clamp((n.traffic.averageSpeed / baseSpeed) * 100),
    incidents: clamp(100 - n.incidents.total * 10),
    weather: clamp(100 - n.weather.rain * 4 - Math.max(0, n.weather.wind - 30) * 2),
    transit: clamp(100 - n.transit.delay * 3.3),
    aqi: clamp(100 - Math.max(0, n.aqi.value - 50) * 0.6),
    tension: clamp(100 - n.tension.value),
  };
  const health = Math.round(Object.keys(C.W).reduce((s, k) => s + sub[k] * C.W[k], 0));
  const factors = [];
  if (S.traffic) factors.push(`Traffic is slower: ${S.traffic.detail}`);
  if (S.incidents) factors.push(`More complaints: ${S.incidents.detail}`);
  if (S.transit) factors.push(`Bus/train delays: ${S.transit.detail}`);
  if (S.weather) factors.push(`Heavy rain: ${S.weather.detail}`);
  if (S.tension) factors.push(`Public mood: ${S.tension.detail}`);
  if (n.aqi.value > C.T.aqi) factors.push(`Poor air quality (AQI ${n.aqi.value})`);
  if (n.utility.power === 'outage-unplanned') factors.push('Unplanned power outage');
  else if (n.utility.power === 'outage-planned') factors.push('Planned power maintenance (not counted against the score)');
  if (n.utility.water === 'outage-unplanned') factors.push('Unplanned water outage');
  if (!factors.length) factors.push('Everything looks normal');

  return {
    zoneId: n.zoneId, name: z.cfg.name, latitude: z.cfg.latitude, longitude: z.cfg.longitude,
    reading: n, signals: S, count, corrScore, level: LEVELS[Math.min(count, 4)], sub, health,
    status: status(health), statusLabel: STATUS_LABEL[status(health)], factors,
    baseline: { speed: Math.round(baseSpeed) },
    stale: Object.keys(fresh).filter((k) => !fresh[k]),
  };
}

// Deterministic, grounded summary (also the fallback when the AI call fails).
function templateSummary(a) {
  const P = { weather: 'heavy rain', traffic: 'slow traffic', incidents: 'more complaints than usual', transit: 'longer bus/train delays', tension: 'more people sounding upset online' };
  if (a.signals.incidents && a.reading.incidents.waterlogging >= 3) P.incidents = 'more waterlogging reports';
  const parts = Object.keys(a.signals).map((k) => P[k]);
  const util = a.reading.utility.power === 'outage-unplanned' ? 'an unplanned power outage' : null;
  if (util) parts.unshift(util);
  if (!parts.length) return `${a.name} looks normal right now.`;
  if (parts.length === 1) return `${a.name}: ${parts[0]} is unusual right now. Nothing else has changed yet.`;
  const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts.slice(-1) : parts[0];
  return `In ${a.name}, ${list} are all happening at the same time. They may be connected.`;
}

// Alert rules: highest matching rule wins.
function alertRule(a) {
  const ev = Object.values(a.signals).map((s) => `${s.label}: ${s.detail}`);
  if (a.reading.utility.power === 'outage-unplanned') return { type: 'Unplanned power outage', level: 'CRITICAL', evidence: ['Grid failure reported by residents', ...ev] };
  if (a.count >= 3) return { type: 'Big problem in this area', level: 'CRITICAL', evidence: ev };
  if (a.signals.weather && a.reading.incidents.waterlogging >= 5) return { type: 'Rain and waterlogging', level: 'WARNING', evidence: ev };
  if (a.reading.traffic.congestion > C.T.congestion) return { type: 'Very heavy traffic', level: 'WARNING', evidence: [`Traffic jam ${a.reading.traffic.congestion}%`, ...ev] };
  if (a.reading.utility.power === 'outage-planned') return { type: 'Planned power maintenance', level: 'NOTICE', evidence: ['Scheduled by the utility, does not lower the score'] };
  if (a.count === 2) return { type: 'Two things going wrong together', level: 'NOTICE', evidence: ev };
  return null;
}

module.exports = { normalize, analyze, templateSummary, alertRule, avg };
