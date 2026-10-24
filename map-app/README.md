# Mallorca relief-map frontend

This is an isolated Vite/TypeScript application built to `site/map/`. It deliberately loads only a reviewed, public snapshot at:

```text
./data/mallorca-map.snapshot.json
```

The source file should therefore be placed at `map-app/public/data/mallorca-map.snapshot.json`. The browser never reads raw FIT files, local analysis paths, activity/effort identifiers, device metadata, exact timestamps, or the private endpoint-redaction centre.

## Preferred snapshot shape

```ts
{
  schemaVersion: "mallorca-relief-v1",
  generatedAt: string,
  map: {
    crs: "EPSG:4326",
    islandBoundsWsen: [west, south, east, north],
    islandBoundary: GeoJSON.Polygon | GeoJSON.MultiPolygon,
    boundarySource: { name: string, attribution: string }
  },
  rides: [{
    rideId: string,
    date: "YYYY-MM-DD",
    label: string,
    subtitle?: string,
    color: string,
    summary: {
      distanceKm: number,
      ascentM: number,
      movingSeconds: number,
      averagePowerW?: number,
      normalizedPowerW?: number,
      trainingLoad?: number
    },
    route: GeoJSON.MultiLineString,
    boundsWsen: [west, south, east, north],
    labelCoordinate?: [longitude, latitude],
    note?: string,
    telemetrySamples: [{
      sampleId: string,
      movingSeconds: number,
      distanceKm: number,
      coordinate: [longitude, latitude],
      recordedAltitudeM: number | null,
      powerMeanW: number | null,
      powerMaxW: number | null,
      heartRateMeanBpm: number | null,
      cadenceMeanRpm: number | null,
      recordedTemperatureC: number | null,
      speedMeanKmh: number | null,
      gradePct: number | null,
      segmentId?: string | null,
      label?: string | null
    }]
  }],
  segments: [{
    segmentId: string,
    rideId: string,
    campLabel: string,
    currentStravaTitle?: string,
    stravaSegmentId: string | number,
    stravaUrl: string,
    matched: boolean,
    geometry: GeoJSON.LineString | GeoJSON.MultiLineString | null,
    startPoint?: [longitude, latitude],
    endPoint?: [longitude, latitude],
    stats: {
      elapsedSeconds: number,
      distanceKm: number,
      elevationGainM: number,
      averageGradePct: number,
      averagePowerW: number,
      averageHeartRateBpm: number
    },
    confidence?: string,
    boundaryBasis?: "exact_fit_timestamp" | "fit_metrics_reconciled",
    note?: string
  }],
  places: [{
    id: string,
    name: string,
    kind: "region" | "orientation" | string,
    coordinates: [longitude, latitude],
    region?: string,
    shortOrientationNote?: string,
    approximate?: boolean
  }],
  provenance: Record<string, string>
}
```

The runtime normalizer accepts a few explicit aliases documented in `src/data.ts`, but the preferred shape above should be used for stable tests. It enforces the reviewed truth invariants: exactly six rides, 17 ledger entries, 15 matched segments, geometry on every matched segment, and no geometry on unmatched entries.

## Renderer/failure contract

- One locally bundled MapLibre instance uses OpenFreeMap Liberty and Mapterhorn DEM tiles.
- An inline same-origin SVG map is the opening and failure renderer. It retains island context, ride and segment geometry, direct labels, selection state, the guide, and the elevation profile.
- The SVG is hidden only after an idle MapLibre frame passes a nonblank WebGL pixel check.
- All map-only actions have a keyboard-accessible guide/list equivalent.
- URL hash state carries ride, segment, point, terrain, guide tab, and camera.
