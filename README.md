# Sa Calobra camp 2026 — ride analysis

A public, mobile-friendly analysis of six consecutive Mallorca rides from 18–23 October 2026.

**Live report:** https://livlisko.github.io/sa-calobra-camp-2026/

**Interactive relief map:** https://livlisko.github.io/sa-calobra-camp-2026/map/

The report covers week load, a gap-safe power-duration curve, genuinely distinct effort counts, ride-by-ride power/heart-rate/elevation traces, named climb efforts, durability, power-zone distribution, and evidence-bound training targets.

## Named segment method

The camp-facing climb names and competition links come from the daily Sa Calobra Cycling Club WhatsApp posts. Those links were reconciled against the matched segment-effort payload for each signed-in Strava activity and cross-checked against Garmin FIT ClimbPro windows.

- 17 coach-posted segments are represented.
- 15 have verified matched efforts.
- Sa Batalla and Santa Llúcia are retained as first-day non-matches after the weather reroute.
- Sant Salvador and Honor use current overlapping Strava segments because the camp-posted historical IDs now return unavailable pages.
- The active-recovery ride is explicitly shown as having no official KOM segment.
- Puig Maria is not presented as completed because it did not match the final activity.

## Public-data boundary

The root report contains derived ride metrics and 30-second relative-time telemetry without GPS coordinates. The relief map intentionally adds downsampled route geometry and coordinate-bearing telemetry after trimming a one-kilometre radius around the repeatedly detected private endpoint. Neither artifact contains raw FIT files, exact clock-time tracks, the private endpoint coordinate, Strava activity/profile identifiers, original FIT filenames, local filesystem paths, emails, tokens, or chat exports.

Both pages load reviewed static JSON snapshots by repository-relative URLs. They do not require a ChatGPT Sites backend or a runtime API.

## Verification

```sh
npm ci
npm run verify
```

The verification command type-checks and builds the relief map, then runs the public-data and evidence checks for both pages. The GitHub Pages workflow repeats the same sequence before every deployment.
