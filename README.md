# KRUNKED // SKY-MAP

> **Live 60fps Aerospace Situational Awareness Command Deck & Serverless Client-Side Astrodynamics Lab**

Krunked Sky-Map is a zero-API-key, dark-cockpit aerospace visualization dashboard that renders everything currently flying or orbiting overhead for any point on Earth—combining a **MapLibre GL JS Tactical Map**, a **High-DPI Polar Sky-Dome Hemisphere Radar** (including a **240×240px PIP** overlay in Map view), **Web Worker SGP4 orbital mechanics**, **WGS-84 topocentric curvature math**, **WindBorne Systems global stratospheric balloon constellations**, **global `/v2/mil`, `/v2/ladd`, and `/v2/pia` ADS-B tracking**, **FAA UAS airspace compliance**, and **procedural WebAudio cockpit acoustics**.

---

## Core Architecture

```text
+-----------------------------------------------------------------------------------+
| TopTelemetryBar (44px): ⌘K Location Palette · LOCAL/GLOBAL Scope · MAP/SPLIT/DOME/PIP |
+------------------------------------+----------------------------------------------+
| MapLibre GL JS (TacticalMap.tsx)   | Polar Sky-Dome (PolarSkyDome.tsx)            |
| - Esri Dark Gray Canvas (zero-key) | - High-DPI ResizeObserver Canvas (90° -> -5°)|
| - 3x Retina procedural sprites     | - 240x240px PIP mode over Map view w/ AZ/EL  |
| - Zoom-decluttered labels & tracks | - Overhead satellite pass arcs + TCA peak    |
| - FAA UASFM / SUA / TFR overlays   | - Bidirectional hover & click target-locking |
| - ATC B6 UAS & ODID tether layers  | - Synchronized phosphor sweep & AZ/EL cursor |
+------------------------------------+----------------------------------------------+
| ControlDock (Bottom-center floating pill: Radius, Layers, Sub-filter trays, Sweep)|
| TargetInspector (Floating 340px card: Speed, Baro/Geom Alt, Vert Rate, Az/El/Rng) |
+-----------------------------------------------------------------------------------+
```

### Command Deck Controls & Views
- **`LOCAL / GLOBAL` Scope Toggle:** Switches seamlessly between cylinder-scoped regional airspace (`10–250 km` around the observer) and planetary situational awareness (global WindBorne stratospheric constellation, widened SondeHub v2 radiosondes, and global `/v2/mil` + `/v2/ladd` + `/v2/pia` ADS-B networks). Switching to `GLOBAL` smoothly eases the tactical map camera out to planetary view; switching back to `LOCAL` restores observer-centered zoom.
- **`⌘K` / `/` Location Command Palette:** Keyboard-driven observer command palette for instant coordinate parsing (`34.9054, -117.8839` or `34.9054N 117.8839W`), aerospace hotspot presets, GPS lock, and Open-Meteo / Nominatim geocoding.
- **`240×240px` PIP Polar Sky-Dome:** When in `MAP` layout mode, the Polar Sky-Dome docks as a compact `240×240px` corner radar HUD featuring live `AZ / EL / RNG` cursor & target lock readouts plus one-click Expand-to-Split and Minimize controls.

---

## Zero-Key Public Data Integrations & Diagnostics

Every data stream runs without user-supplied API keys, guarded by `AbortController` timeouts, token-bucket rate limiters, isolated circuit breakers, and honest `LIVE` | `DELAYED` | `RATE-LIMITED` | `OFFLINE` | `CACHED` | `FALLBACK` | `ERROR` status badges:

1. **Civil & Global Military / LADD / PIA / ATC UAS & LTA ADS-B (`src/services/flightsService.ts`)**
   - **Local `/v2/point` Cascade:** Local Vite dev/preview proxy (`/api-proxy/adsb-fi`, `/api-proxy/adsb-lol`, `/api-proxy/airplanes-live`) -> zero-preflight `r.jina.ai` CORS relay -> direct browser cascade (`api.adsb.lol` -> `opensky-network.org`).
   - **Global `/v2/mil`, `/v2/ladd` & `/v2/pia` Telemetry:** Independent `18s` governor (`globalAdsbRateLimiter`) and isolated `globalFlightsCircuitBreaker` polling `/v2/mil`, `/v2/ladd`, and `/v2/pia` across local Vite proxies, zero-preflight `r.jina.ai` CORS relays, and direct `api.adsb.lol`, deduplicated cleanly by normalized ICAO hex.
   - **Verified-Live Telemetry Only:** Zero fabricated or static fallback flights (`fallback-flights.json` removed). Landed (`onGround`), stale (`seen_pos > 60s`), out-of-range, and Null Island `(0, 0)` observations are purged, while high-altitude floaters/UAS with `alt_baro: null` and valid `alt_geom` up to `70,000 m` or `gs === 0` are retained cleanly.
   - **Classification & Cross-Category Routing:** Separates civil traffic from military/LADD/PIA aircraft via `dbFlags`, expanded military ICAO hex allocations, military type codes, and callsign prefixes; highlights emergency squawks (`7700`, `7600`, `7500`); routes **`B6` / unmanned ATC UAS** (`RQ4`, `MQ9`, `MQ4C`, etc.) into the `drone` layer (`LIVE ATC UAS`); and routes **`B2` / stratospheric LTA** (`HBAL`, `STRAT`, `BALL`) into the `balloon` layer (`ADS-B LTA`).
2. **WindBorne Systems Global Balloon Constellation & SondeHub v2 (`src/services/balloonsService.ts`)**
   - **WindBorne 3-Tier CORS Transport:** Fetches `https://a.windbornesystems.com/treasure/{00,01,02}.json` via:
     1. Local Vite dev/preview proxy (`/api-proxy/windborne`) when running locally,
     2. Static production zero-preflight `r.jina.ai` CORS relay + direct browser fallback,
     3. Build-seeded `./data/windborne-balloons.json` emergency snapshot (`CACHED` badge) only when live + relay fail and cache is empty/expired.
   - **3D Kinematics & 5-Minute TTL Cache:** Validates `[lat, lon, altKm]` tuples defensively, correlates aligned indices across `T-0h` (`00.json`), `T-1h` (`01.json`), and `T-2h` (`02.json`) with a `450 km` slot-reassignment teleport guard, computes Antimeridian-safe ground speed, bearing, vertical ascent/descent rate, and historical trails, and caches raw arrays in `IndexedDB` (`krunked_windborne_v1`) with a **5-minute TTL**.
   - **SondeHub v2 Radiosondes:** Queries **SondeHub v2** (`/sondes` + `/amateur`), detects burst/parachute descent (`vel_v < -1.2 m/s`), extracts RF frequency & meteorological readings, and widens to `>= 600 km` in `GLOBAL` scope or computes a nearest-sonde bearing/distance hint in `LOCAL` scope.
3. **Active Satellites via Client-Side SGP4 (`src/services/satellitesService.ts`, `src/workers/astro.worker.ts`)**
   - **0ms Cold Boot:** Loads build-seeded TLE catalogs from `./data/tle/{stations,visual,starlink}.tle`.
   - **Background Sync:** Refreshes CelesTrak GP elements (`stations`, `visual`, `starlink`) only when the browser `IndexedDB` cache (`krunked_tle_v1`) exceeds its **2-hour TTL**.
   - **Dedicated Web Worker:** Propagates satellites off the main thread via `satellite.js`, transferring stride-12 `Float32Array` kinematics (`lat`, `lon`, `altM`, `speedMs`, `headingDeg`, `azDeg`, `elDeg`, `slantRangeKm`, `groundDistKm`, `sunlit`, `radialVelocityKmS`, `dopplerHz437MHz`).
4. **FAA Drone Airspace, TFRs & OpenDroneID (`src/services/airspaceService.ts`, `src/services/openDroneIdService.ts`)**
   - Queries **FAA ArcGIS FeatureServers** for UAS Facility Map LAANC grid ceilings (`FAA_UAS_FacilityMap_Data`), `Special_Use_Airspace`, and `Boundary_Airspace` (with automatic non-US coverage detection and `./data/fallback-airspace.geojson` fallback).
   - Merges live **ATC `B6` UAS** with a configurable **OpenDroneID WebSocket / HTTP JSON webhook drawer** and opt-in **4-drone ASTM F3411 local simulator (`SIM-ODID`, off by default)** with real-time **UASFM ceiling / TFR incursion detection** (`altM <= 500` for low-altitude LAANC checks).
5. **Location & Geocoding (`src/services/geocodingService.ts`)**
   - Instant client-side coordinate parsing (`34.9054, -117.8839` or `34.9054N 117.8839W`), non-blocking browser geolocation, aerospace hotspot presets, and **Open-Meteo Geocoding** with **Nominatim** fallback.

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
- **Versioned Service Worker (`public/sw.js`):** Network-first app-shell caching (`krunked-skymap-v4`) that pre-caches core shell assets for offline boot and deletes superseded caches (`krunked-skymap-v1`, `krunked-skymap-v2`, `krunked-skymap-v3`) on activation, while strictly bypassing cross-origin requests, `/api-proxy/` routes (including `/api-proxy/windborne` and ADS-B proxies), same-origin `.json` data requests (`public/data/windborne-balloons.json` and live JSON endpoints, excluding `./manifest.json`), and Vite HMR dev paths so telemetry is never served stale.

---

## Local Development & Verification

```bash
npm install
npm run seed                           # Refresh static CelesTrak TLEs, FAA airspace & WindBorne snapshot
node scripts/generate-pwa-icons.mjs    # Regenerate raster PNG PWA & Apple Touch icons
npm run dev                            # Start Vite dev server with live /api-proxy ADS-B & WindBorne relays
npm run typecheck                      # Strict TypeScript check
npm run test                           # Unit geodesy, ingestion & adversarial chaos test suites
npm run build                          # Emit static GitHub Pages bundle under dist/
npm run preview                        # Preview built bundle locally
```

---

## GitHub Pages Deployment

`.github/workflows/deploy-pages.yml` generates PWA PNG icons, refreshes static CelesTrak ephemeris, FAA airspace, and WindBorne constellation snapshots, verifies types/tests, and builds/deploys the static bundle automatically on pushes to `main`, manual `workflow_dispatch`, and a 6-hourly scheduled cron (`0 */6 * * *`):

1. Push this repository to GitHub (`main` branch).
2. In your GitHub repository, open **Settings -> Pages** and set **Source** to **GitHub Actions**.
3. Trigger or await the **Deploy Krunked Sky-Map to GitHub Pages** workflow. Because `vite.config.ts` compiles with `base: './'`, the app runs cleanly at both root custom domains and `/<repo-name>/` project URLs.
