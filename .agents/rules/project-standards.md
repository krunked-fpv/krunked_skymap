# Krunked Sky-Map Project Standards

## 1. Security, Hygiene & Model Routing
- **Zero Hardcoded Secrets:** Never hardcode API keys, tokens, or credentials. All public data feeds in Krunked Sky-Map are zero-key by design.
- **Model-Agnostic Routing:** Never hardcode model version numbers or release strings anywhere in `.agents/`, scripts, workflows, or code. Route exclusively using abstract capability tiers (`inherit`, `pro`, `flash`).
- **Clean-Room Discipline:** Do not leave `.bak` files, scratch files, or temporary symlinks/junctions in committed branches.

## 2. Toolchain Execution on Windows PowerShell
- Portable Node.js v22 LTS lives at `$env:LOCALAPPDATA\nodejs-v22`. Every PowerShell invocation of `node`, `npm`, or `npx` MUST prepend:
  ```powershell
  $env:PATH = "$env:LOCALAPPDATA\nodejs-v22;$env:PATH"
  ```

## 3. TypeScript & Runtime Reliability
- Strict TypeScript (`strict: true`, `noImplicitAny: true`, `strictNullChecks: true`). Zero `any` escapes in domain contracts (`src/types/sky-contracts.ts`).
- Zero unhandled promise rejections and zero console/runtime errors during normal or degraded network operation.
- All external network requests MUST use `AbortController` timeouts, schema guards, and graceful fallbacks (`LIVE` -> `CACHED` -> `FALLBACK`).

## 4. Astrodynamics & 60fps Architecture
- **WGS-84 Ellipsoidal Math Only:** All topocentric Azimuth, Elevation, and Slant Range computations MUST transform WGS-84 geodetic coordinates to ECEF ($a = 6378137.0\text{ m}$, $f = 1 / 298.257223563$) and rotate into local ENU—never approximate elevation with flat-Earth trig.
- **Worker Isolation:** All SGP4 propagation via `satellite.js` MUST execute inside the dedicated Web Worker (`src/workers/astro.worker.ts`) using transferable `Float32Array` payloads.
- **Zero React GC Churn at 60fps:** High-frequency dead-reckoning kinematics flow through `liveKinematicsRegistry` for `requestAnimationFrame` consumers (`TacticalMap` and `PolarSkyDome`).

## 5. GitHub Pages Portability
- `vite.config.ts` MUST use `base: './'` so `dist/` deploys cleanly at both custom root domains and `/<repo-name>/` project subpaths.
- Static cold-start ephemeris and fallback snapshots live in `public/data/` and are refreshed at build/cron time by `scripts/refresh-ephemeris.mjs`.
