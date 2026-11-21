# KRUNKED // SKY-MAP

> **Live 60fps Aerospace Situational Awareness Command Deck & Serverless Client-Side Astrodynamics Lab**

Krunked Sky-Map is a zero-API-key, dark-cockpit aerospace visualization dashboard that renders everything currently flying or orbiting overhead for any point on Earth—combining a **MapLibre GL JS Tactical Map**, a **High-DPI Polar Sky-Dome Hemisphere Radar**, **Web Worker SGP4 orbital mechanics**, **WGS-84 topocentric curvature math**, **FAA UAS airspace compliance**, and **procedural WebAudio cockpit acoustics**.

---

## Core Architecture

```text
+-----------------------------------------------------------------------------------+
| TopTelemetryBar: Observer Pill · Live Category Badges · Zenith Counter · FPS/SGP4 |
+------------------------------------+----------------------------------------------+
| MapLibre GL JS (TacticalMap.tsx)   | Polar Sky-Dome (PolarSkyDome.tsx)            |
| - Esri Dark Gray Canvas (zero-key) | - High-DPI ResizeObserver Canvas (90° -> -5°)|
| - 2x Retina procedural sprites     | - 15° azimuth spokes & horizon/OTH rings     |
| - 60s velocity leaders & trails    | - Overhead satellite pass arcs + TCA peak    |
| - FAA UASFM / SUA / TFR overlays   | - Bidirectional hover & click target-locking |
| - OpenDroneID operator tethers     | - Synchronized phosphor sweep & AZ/EL cursor |
+------------------------------------+----------------------------------------------+
| ControlDock (Location / Presets / 10–250 km Radius / Layers / Countdown Rings)    |
| TargetInspector (Slide-out drawer: Speed, Baro/Geom Alt, Vert Rate, Az/El/Range)  |
+-----------------------------------------------------------------------------------+
```

---

## Zero-Key Public Data Integrations & Diagnostics

Every data stream runs without user-supplied API keys, guarded by `AbortController` timeouts, token-bucket rate limiters, circuit breakers, and honest `LIVE` | `DELAYED` | `RATE-LIMITED` | `OFFLINE` | `CACHED` | `FALLBACK` | `ERROR` status badges:

1. **Civil & Military / Uncensored ADS-B Flights (`src/services/flightsService.ts`)**
   - **Cascade:** Local Vite dev/preview proxy (`/api-proxy/adsb-fi`, `/api-proxy/adsb-lol`, `/api-proxy/airplanes-live`) -> direct browser cascade (`api.adsb.lol` -> `api.airplanes.live` -> `opensky-network.org`) -> schema-validated CORS JSON relay.
   - **Verified-Live Telemetry Only:** Zero fabricated or static fallback flights (`fallback-flights.json` removed). Landed (`onGround`), stale (`seen_pos > 60s`), out-of-range, and Null Island `(0, 0)` observations are purged, and valid empty `{ ac: [] }` / `{ states: [] }` responses resolve honestly as `LIVE` (`0` aircraft). When upstreams fail or throttle (`HTTP 429`), the HUD surfaces honest `DELAYED` (recent verified `< 45s` tracks only), `RATE-LIMITED`, `OFFLINE`, or `ERROR` diagnostics with exact `Last Updated` timestamps (`HH:MM:SS`) and provider metadata.
   - **Classification:** Separates civil traffic from military/LADD/PIA aircraft via `dbFlags`, military ICAO hex allocations, and military callsign prefixes, plus highlights emergency squawks (`7700`, `7600`, `7500`).
2. **Active Satellites via Client-Side SGP4 (`src/services/satellitesService.ts`, `src/workers/astro.worker.ts`)**
   - **0ms Cold Boot:** Loads build-seeded TLE catalogs from `./data/tle/{stations,visual,starlink}.tle`.
   - **Background Sync:** Refreshes CelesTrak GP elements (`stations`, `visual`, `starlink`) only when the browser `IndexedDB` cache (`krunked_tle_v1`) exceeds its **2-hour TTL**.
   - **Dedicated Web Worker:** Propagates satellites off the main thread via `satellite.js`, transferring stride-12 `Float32Array` kinematics (`lat`, `lon`, `altM`, `speedMs`, `headingDeg`, `azDeg`, `elDeg`, `slantRangeKm`, `groundDistKm`, `sunlit`, `radialVelocityKmS`, `dopplerHz437MHz`).
3. **Weather Balloons / Radiosondes (`src/services/balloonsService.ts`)**
   - Queries **SondeHub v2** (`/sondes` + `/amateur`), detects burst/parachute descent (`vel_v < -2.0 m/s`), extracts RF frequency & meteorological readings, and computes a nearest-sonde bearing/distance hint when zero sondes sit inside narrow scan radii.
4. **FAA Drone Airspace, TFRs & OpenDroneID (`src/services/airspaceService.ts`, `src/services/openDroneIdService.ts`)**
   - Queries **FAA ArcGIS FeatureServers** for UAS Facility Map LAANC grid ceilings (`FAA_UAS_FacilityMap_Data`), `Special_Use_Airspace`, and `Boundary_Airspace` (with automatic non-US coverage detection and `./data/fallback-airspace.geojson` fallback).
   - Includes a toggleable **4-drone ASTM F3411 local simulator (`SIM-ODID`)** with live ground-operator coordinates and real-time **UASFM ceiling / TFR incursion detection**, plus a configurable **OpenDroneID WebSocket / HTTP JSON webhook drawer**.
5. **Location & Geocoding (`src/services/geocodingService.ts`)**
   - Instant client-side coordinate parsing (`34.9054, -117.8839` or `34.9054N 117.8839W`), non-blocking browser geolocation, 6 aerospace hotspot presets, and **Open-Meteo Geocoding** with **Nominatim** fallback.

---

## Astrodynamics & Geodesy Pipeline (`src/math/geodesy.ts`)

- **Exact WGS-84 Ellipsoidal Look Angles:** Transforms observer and target geodetic coordinates to ECEF ($a = 6378137.0\text{ m}$, $f = 1/298.257223563$), rotates $\Delta\mathbf{r}$ into local East-North-Up `(e, n, u)`, and computes exact topocentric Azimuth, geometric/refracted Elevation (handling Earth curvature horizon drop-off across `10–250 km` and beyond), and Slant Range.
- **Antimeridian & Polar Safety:** Splits orbital ground tracks and geodesic circles cleanly across `±180°` longitude and interpolates polar enclosures without horizontal wrap artifacts.
- **60fps Dead Reckoning:** Atmospheric targets and worker-propagated orbital entities extrapolate smoothly via `requestAnimationFrame` into `liveKinematicsRegistry` without triggering React reconciliation churn.

---

## OpenDroneID Webhook JSON Contract

Connect a `ws://`, `wss://`, `http://`, or `https://` endpoint via the **ODID STREAM** modal emitting single objects, arrays, or `{ "drones": [...] }` frames:

```json
{
  "drones": [
    {
      "uasId": "1581F45TB234100A92",
      "uaType": "multirotor",
      "lat": 38.8542,
      "lon": -77.0431,
      "altAglM": 92,
      "altMslM": 104,
      "speedMs": 14.2,
      "headingDeg": 128,
      "vertRateMs": 0.4,
      "operatorLat": 38.8529,
      "operatorLon": -77.0445,
      "missionDesc": "Bridge structural inspection",
      "timestampMs": 1763601746000
    }
  ]
}
```

---

## Installable PWA & Standalone WebAPK

Krunked Sky-Map supports standalone installation on desktop and mobile devices (including GitHub Pages `/<repo-name>/` subpaths via relative scoping):

- **Web App Manifest (`public/manifest.json`):** Configured with `start_url: "./"`, `scope: "./"`, `display: "standalone"`, and `#06090F` obsidian theme/background colors.
- **Raster PNG Icons (`scripts/generate-pwa-icons.mjs`):** Zero-dependency Node script generating valid `192x192`, `512x512`, and `180x180` (`apple-touch-icon.png`) binary PNG radar icons inside the maskable safe zone (`public/icons/`).
- **Versioned Service Worker (`public/sw.js`):** Network-first app-shell caching (`krunked-skymap-v2`) that pre-caches core shell assets for offline boot and deletes superseded caches on activation, while strictly bypassing cross-origin requests, live telemetry APIs, `/api-proxy/` routes, and Vite HMR dev paths so radar/flight data is never served stale.

---

## Local Development & Verification

```bash
npm install
npm run seed                           # Refresh static CelesTrak TLEs & FAA airspace snapshots
node scripts/generate-pwa-icons.mjs    # Regenerate raster PNG PWA & Apple Touch icons
npm run dev                            # Start Vite dev server with live /api-proxy ADS-B relays
npm run typecheck                      # Strict TypeScript check
npm run test                           # Unit geodesy, ingestion & adversarial chaos test suites
npm run build                          # Emit static GitHub Pages bundle under dist/
npm run preview                        # Preview built bundle locally
```

---

## GitHub Pages Deployment

`.github/workflows/deploy-pages.yml` generates PWA PNG icons, refreshes static CelesTrak ephemeris and FAA airspace snapshots, verifies types/tests, and builds/deploys the static bundle automatically on pushes to `main`, manual `workflow_dispatch`, and a 6-hourly scheduled cron (`0 */6 * * *`):

1. Push this repository to GitHub (`main` branch).
2. In your GitHub repository, open **Settings -> Pages** and set **Source** to **GitHub Actions**.
3. Trigger or await the **Deploy Krunked Sky-Map to GitHub Pages** workflow. Because `vite.config.ts` compiles with `base: './'`, the app runs cleanly at both root custom domains and `/<repo-name>/` project URLs.
