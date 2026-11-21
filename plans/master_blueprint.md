# Krunked Sky-Map — Master Architectural Blueprint

## 1. Phase 0 Reconnaissance Findings
- **Repository Baseline:** Greenfield directory at `c:\krunked_skymap` initialized onto branch `main`.
- **Toolchain Note (Windows):** Node.js v22 LTS portable distribution resides at `$env:LOCALAPPDATA\nodejs-v22`. All PowerShell commands invoking `node`/`npm`/`npx` must include `$env:PATH = "$env:LOCALAPPDATA\nodejs-v22;$env:PATH"`.
- **Public Zero-Key API Verification:**
  - `CelesTrak` (`/NORAD/elements/gp.php?GROUP={stations|visual|starlink}&FORMAT=tle`): Direct CORS `*`. Cold boot uses build-seeded `./data/tle/*.tle`, refreshed asynchronously with a strict **2-hour IndexedDB TTL** (`krunked_tle_v1`).
  - `SondeHub v2` (`https://api.v2.sondehub.org/sondes` & `/amateur`): Direct CORS `*`.
  - `Open-Meteo Geocoding` (`https://geocoding-api.open-meteo.com/v1/search`): Direct CORS `*` with Nominatim fallback.
  - `FAA ArcGIS FeatureServers` (`FAA_UAS_FacilityMap_Data` queried via `where=LATITUDE BETWEEN ... AND LONGITUDE BETWEEN ...`, plus `Special_Use_Airspace` and `Boundary_Airspace` queried via spatial envelope): Direct CORS `*`, US airspace coverage check included, with `./data/fallback-airspace.geojson` fallback.
  - `ADS-B Cascade (Zero Phantom / Verified Live Only)`: Local `vite dev` / `vite preview` proxies `/api-proxy/adsb-fi`, `/api-proxy/adsb-lol`, and `/api-proxy/airplanes-live` -> Direct browser cascade (`adsb.lol` -> `airplanes.live` -> `opensky-network.org`) -> Schema-validated CORS JSON relay (`api.codetabs.com`). Zero synthetic/fallback aircraft are ever fabricated or translated around the observer (`public/data/fallback-flights.json` purged; `SIM-ODID` defaults to `false`). Honest `FeedHealthStatus` (`live`, `delayed`, `rate-limited`, `offline`, `error`) surfaces exact `lastUpdatedMs` and verified aircraft count in the HUD.

## 2. Directory & Exclusive File Ownership Matrix

| Specialist Role | Tier | Exclusive Paths |
| :--- | :--- | :--- |
| `@mission-architect` | `inherit` | `plans/master_blueprint.md`, `.agents/rules/*`, `src/types/*`, `src/store/*`, `src/App.tsx`, `src/main.tsx` |
| `@orbital-kinematics` | `inherit` | `src/math/*`, `src/workers/*`, `tests/unit/math.test.ts` |
| `@telemetry-ingest` | `pro` | `src/services/*`, `tests/unit/ingest.test.ts` |
| `@maplibre-tactical` | `pro` | `src/components/map/*`, `src/assets/sprites/*` |
| `@skydome-acoustics` | `pro` | `src/components/skydome/*`, `src/audio/*` |
| `@cockpit-hud-ui` | `pro` | `src/components/hud/*`, `src/components/inspector/*`, `src/styles/*` |
| `@ops-pages-custodian` | `flash` | `.github/workflows/deploy-pages.yml`, `scripts/*`, `public/data/*`, `vite.config.ts`, `index.html` |
| `@astro-redteam` | `inherit` | `tests/adversarial/*`, `plans/redteam_audit.md` |

## 3. Data-Flow & 60fps Kinematics Topology
1. **Shared Contracts (`src/types/sky-contracts.ts`):** Immutable discriminated union `SkyEntity` (`FlightEntity | SatelliteEntity | BalloonEntity | DroneEntity`), `ObserverLocation`, `TopocentricCoords`, `FeedTelemetryState`, `AirspaceData`, `SatelliteOrbitOverlay`, `WorkerRequestMessage`, `WorkerResponseMessage`.
2. **State Partition (`src/store/useSkyStore.ts`):**
   - **Zustand Store (`useSkyStore`):** Low-frequency reactive UI state (observer, radiusKm, layer visibility, orbitalScope, satellite group filters, units, layout mode, audio enabled/volume, feed telemetry states & countdowns, selected entity ID, hovered entity ID, follow mode, OpenDroneID config, airspace collections, nearest sonde hint, and a ~5Hz synced snapshot map for Inspector readouts).
   - **High-Frequency Registry (`liveKinematicsRegistry`):** Mutable non-React `Map<string, SkyEntity>` + `orbitOverlay` + `version` updated at 60fps via `extrapolateDeadReckoning` and Web Worker SGP4 batches (`Float32Array`), read directly inside `TacticalMap` and `PolarSkyDome` `requestAnimationFrame` loops with zero React reconciliation overhead.
3. **Web Worker SGP4 Protocol (`src/workers/astro.worker.ts`):**
   - `init-tles` -> Parses TLEs via `satellite.twoline2satrec`, validates `satrec.error === 0`, caches orbital metadata (`noradId`, `name`, `group`, `inclinationDeg`, `periodMin`, `apogeeKm`, `perigeeKm`), responds `{ type: 'ready', count }`.
   - `update-config` -> Sets observer `(lat, lon, altM)`, `radiusKm`, `orbitalScope` (`cylinder` | `hemisphere`), active `groups`.
   - `tick` -> Propagates active `satrec` records for `timestampMs`, computes WGS-84 geodetic `(lat, lon, altKm)`, speed, heading, look angles `(azDeg, elDeg, slantRangeKm, groundDistKm)`, cylindrical Earth-shadow `sunlit`, and `radialVelocityKmS` / `dopplerHz437MHz`. Emits transferable `Float32Array` stride-11 kinematics buffer + compact metadata list.
   - `compute-orbit` -> Computes `-10 min` to `+20 min` Antimeridian-split ground track segments, footprint radius, and Sky-Dome `(azDeg, elDeg)` pass arc with peak TCA marker for the selected satellite.

## 4. API Rate-Limit & Refresh Budgets
- **Flights (`flights`):** `10s` interval, strict 10s token-bucket floor, 3.5s per-attempt timeout.
- **Satellites (`satellites`):** Continuous 10Hz Worker SGP4 propagation interpolated to 60fps; cold boot from `./data/tle/*.tle`; CelesTrak network refresh capped to 2h `IndexedDB` TTL.
- **Weather Balloons (`balloons`):** `30s` interval via SondeHub v2 CORS API.
- **FAA Airspace (`airspace`):** Triggered on observer/radius change (debounced 500ms) + 300s periodic refresh; UASFM envelope capped to `min(radiusKm, 50 km)` (`±0.35°` max).
- **OpenDroneID (`drones`):** `1s` simulation tick or live WebSocket/HTTP JSON stream, cross-checked locally against active UASFM & SUA polygons for live `ceilingBreach` / `tfrBreach`.

## 5. Semantic Palette & Responsive Viewport Bar
- `flight`: `#22D3EE` (Electric Cyan)
- `military`: `#F59E0B` (Tactical Amber) / `#EF4444` (Squawk 7700/7600/7500 Crimson)
- `satellite`: `#C084FC` (Orbital Violet; `#E879F9` sunlit / `#7E22CE` eclipsed)
- `balloon`: `#34D399` (Stratospheric Emerald)
- `drone`: `#A3E635` (Compliant UAS) / `#FB7185` (TFR & Ceiling Breach Coral)
- **Viewport & Installable PWA:** `100dvh x 100dvw`, zero page scrollbars, `overscroll-behavior: none`, `env(safe-area-inset-*)` mobile safe-area compliance, tabular numerals throughout, responsive `<= 860px` bottom-sheet mobile layout, high-DPI collision-culled Map & Sky-Dome rendering, relative-scoped `./manifest.json` + `./sw.js` (network-first shell, live telemetry API cache bypass), valid `192x192`/`512x512` PNG icons, and dismissible `beforeinstallprompt` HUD trigger.

## 6. Goal-Grade Verification Gates
1. `node scripts/refresh-ephemeris.mjs` generates valid static TLEs + flight/airspace snapshots.
2. `npm run typecheck` exits `0` (strict TypeScript).
3. `npm run test` exits `0` (unit math + ingest + adversarial chaos suites).
4. `npm run build` emits `dist/index.html` with relative `./assets/` paths for GitHub Pages.
5. Live `browser` subagent audit on `http://127.0.0.1:4173/` confirms zero console/page errors, dual Map + Polar Sky-Dome rendering, interactive layers/presets/radius/units/inspector/OpenDroneID modal, and `390x844` mobile integrity.
