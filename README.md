# CityPulse: live civic health dashboard

CityPulse fuses weather, traffic, civic incidents and transit into one per-zone view. It detects when several
independent signals change together in the same zone and time window, and explains it in plain language.
It says "coincides with" and "possible link", never "caused by".

## Run it
```bash
npm install
cp .env.example .env    # optional
npm start               # http://localhost:4000
```
Requires Node 18+. Zones, thresholds and weights live in `server/config.js`.

## How to use
1. **Whole city:** type any city in the search box and tap a result. CityPulse shows that city as 6 areas on the map, with its score, real weather and air quality.
2. **Route:** open the "Route (from A to B)" tab, choose From and To, press Check route. You get the road on the map, the usual drive time, the time right now, and the slowest part.
3. **Demo buttons:** "Simulate heavy rain" hits the city centre (or the middle of the route). A pop-up alert appears in the top-right corner. "Reset demo" clears it.
4. **Why do numbers change?** Button in the header. Weather and air quality are real (Open-Meteo). Traffic, complaints and bus/train delays are demo data.

Needs internet: search (Open-Meteo geocoding), routes (OSRM demo server), map tiles (OpenStreetMap).

## Architecture
`simulator / Open-Meteo` -> `normalize` (common model, 10-min windows) -> `anomaly rules` (rolling baseline) ->
`correlation` (signals per zone, scored 25/25/30/20) -> `health score` (traffic 30, incidents 30, weather 20, transit 15, AQI 5) ->
`alerts` -> `AI summary (Gemini, template fallback)` -> `Socket.IO` -> dashboard.

Files: `server/config.js`, `server/engine.js` (all analytics), `server/index.js` (feeds, simulator, REST, sockets), `public/index.html` (UI).

## Real vs simulated data
Weather tries Open-Meteo (no key). If it fails, the simulator takes over. Traffic, incidents and transit are simulated.
No personal data is stored: incidents carry only type and severity, per zone.

## API
GET `/api/zones|weather|traffic|incidents|transit|health|alerts|correlations|history|feed-status`, GET `/api/summary/:zoneId`,
POST `/api/simulation/heavy-rain|traffic-incident|reset|outage/:feed`.

## Not in this lean build (future work)
React/Tailwind/Recharts client, MongoDB persistence, History/Replay page, Isolation Forest, 30 s monitoring agent.

## What's new: 12 areas, public mood, utilities, crowdsourced reports, commute
- **12 areas per city** (1 centre + 5 inner ring + 6 outer ring) instead of 6, so bigger cities are more realistic.
- **Public mood (tension) signal:** an anonymous 0-100 score meant to represent "how upset does this area sound", simulated in this demo (no real posts or accounts are read). It's one more input into the health score and correlation, alongside weather, traffic, incidents and transit.
- **Utilities with planned vs unplanned outages:** "Simulate maintenance (planned)" raises a NOTICE and does **not** lower the score. "Simulate power outage (unplanned)" raises a CRITICAL alert and cascades: it gradually drags down traffic speed (dead signals) and raises public mood/tension in that area, the same way one real failure tends to spread into others. This cascade is a simple, transparent rule in `server/index.js`, not a physics simulation.
- **Crowdsourced reports with consensus:** the "Report an issue" card posts to `POST /api/report` with only an area, an issue type and a timestamp — no names, phone numbers or addresses. One report changes nothing. Once **15 reports** of the same type, in the same area, arrive within a rolling **5-minute** window, CityPulse verifies it; for power/water outages, verification triggers the same cascade as the demo button. Thresholds live in `server/config.js` (`report.threshold`, `report.windowMs`).
- **Find my area & commute:** the "📍 Find my area" button uses the browser's Geolocation API (never stored) to find your nearest area via `GET /api/nearest`. You can then pick a destination area and get a straight-line ETA (`GET /api/commute`) using the current traffic speed at both ends. This is a simplified estimate, not a turn-by-turn route — use the Route tab for that.
- **Weather source:** if you set `OPENWEATHER_API_KEY`, CityPulse tries OpenWeatherMap first for temperature/wind/rain and falls back to Open-Meteo automatically if the key is missing, invalid, or rate-limited. Air quality always comes from Open-Meteo.

New endpoints: `POST /api/report`, `GET /api/nearest`, `GET /api/commute`, `POST /api/simulation/power-outage/:mode`, `POST /api/simulation/crowd-surge`.
