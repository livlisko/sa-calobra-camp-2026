# Sa Calobra camp 2026 — ride analysis

A public, mobile-friendly analysis of six consecutive Mallorca rides from 18–23 October 2026.

**Live report:** https://livlisko.github.io/sa-calobra-camp-2026/

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

The published bundle contains derived ride metrics and 30-second relative-time telemetry because this is intentionally a public performance report. It does **not** contain raw FIT files, GPS coordinates, exact clock-time tracks, Strava activity/profile identifiers, original FIT filenames, file hashes, local filesystem paths, emails, tokens, or chat exports.

The static page loads one content-addressed JSON snapshot by a repository-relative URL. It does not require a ChatGPT Sites backend or a runtime API.

## Verification

```sh
npm test
```

The GitHub Pages workflow runs the public-data and evidence checks before every deployment.
