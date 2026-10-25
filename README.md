# Mallorca in six rides — relief atlas

An interactive, mobile-friendly relief atlas of six Sa Calobra Cycling Club rides across Mallorca in October 2026.

**Live atlas:** https://livlisko.github.io/sa-calobra-camp-2026/

The repository publishes one artifact: the atlas at `/map/`. The repository root redirects there so existing root bookmarks still open the map. The atlas combines an island-wide relief view, ride routes, sampled telemetry, verified climb boundaries, and a browser-only FIT importer for comparing repeat attempts on the same segment boundary over time.

## Public-data boundary

The public map includes downsampled route geometry and coordinate-bearing telemetry after trimming a one-kilometre radius around the repeatedly detected private endpoint. It contains no raw FIT files, exact clock-time tracks, private endpoint coordinate, Strava activity or profile identifiers, source filenames, local filesystem paths, emails, tokens, or chat exports.

Historical FIT files selected in the comparison view are parsed locally in a same-origin web worker. Raw files, full tracks, filenames, and device identifiers are not uploaded or published. Remembering derived effort summaries is opt-in and local to that browser.

## Sources and limitations

Road and summit positions are attributed in the app to OpenStreetMap contributors. Summit elevations use Govern de les Illes Balears sources, map tiles are provided by OpenFreeMap, and terrain uses Mapterhorn. Orientation regions are approximate rather than official boundaries, and the atlas is for ride exploration rather than turn-by-turn navigation.

## Verification

```sh
npm ci
npm run verify
```

The verification command type-checks and builds the relief atlas, then checks the public shell, map data, privacy boundary, and local FIT-import behavior. The GitHub Pages workflow repeats the same sequence before every deployment.
