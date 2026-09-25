// All thresholds, weights and points-per-city live here so they are easy to change.
module.exports = {
  tickMs: 4000,
  windowMs: 10 * 60 * 1000, // correlation time window (10 min)
  staleMs: 45 * 1000, // feed older than this = DELAYED
  areasPerCity: 12, // 1 centre + 5 inner ring + 6 outer ring
  T: { rain: 10, speedRatio: 0.7, incidentMult: 2, incidentMin: 3, delay: 15, aqi: 150, congestion: 80, tension: 65 },
  W: { traffic: 0.27, incidents: 0.27, weather: 0.18, transit: 0.13, aqi: 0.05, tension: 0.1 }, // health weights
  P: { weather: 20, traffic: 20, incidents: 25, transit: 15, tension: 20 }, // CityPulse Correlation Score points
  // Crowdsourced-report consensus: a single report is logged but ignored; this many reports of the
  // same type in the same area within this rolling window are treated as a verified event.
  report: { threshold: 15, windowMs: 5 * 60 * 1000 },
};
