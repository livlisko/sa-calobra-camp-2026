import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const snapshot = JSON.parse(await readFile(new URL("../../map-app/public/data/mallorca-map.snapshot.json", import.meta.url), "utf8"));

test.setTimeout(90_000);

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, route => route.abort());
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`all six rides expose their posted climbs and recorded efforts at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/map/#tab=rides");
    const guide = page.locator("#guide-content");
    const group = guide.locator(".ride-climbs");
    for (const ride of snapshot.rides) {
      await guide.locator(`[data-ride-id="${ride.rideId}"]`).click();
      await expect(group.getByRole("heading", { name: "Climbs on this ride" })).toBeVisible();
      const segments = snapshot.segments.filter(s => s.rideId === ride.rideId);
      await expect(group.locator(".segment-list strong")).toHaveText(segments.map(s => s.campLabel));
      if (!segments.length) await expect(group).toContainText("No official camp KOM segment");
      const maxKm = Math.max(...ride.telemetrySamples.map(p => p.distanceKm));
      for (const segment of segments) {
        const row = group.getByRole("listitem").filter({ has: page.getByText(segment.campLabel, { exact: true }) });
        const rank = segment.reportedResult;
        const different = rank && String(rank.stravaSegmentId) !== String(segment.stravaSegmentId);
        const link = row.getByRole("link", { name: new RegExp(different ? "mapped segment on Strava" : "on Strava") });
        await expect(link).toHaveAttribute("href", segment.stravaUrl);
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(row.locator("button a, a button")).toHaveCount(0);
        if (rank) {
          const rankLabel = rank.source === "camp-report" ? "Reported Strava rank" : "Recorded Strava rank";
          await expect(row.locator(".camp-rank")).toHaveText(`${rankLabel} ${rank.position.toLocaleString("en")} of ${rank.fieldSize.toLocaleString("en")}${rank.scope ? " · " + rank.scope : ""}`);
        } else {
          await expect(row.locator(".camp-rank")).toHaveCount(0);
        }
        if (different) {
          const original = row.locator(".original-camp-result");
          await expect(original).toContainText("Original camp segment (retired)");
          await expect(original.locator(".camp-rank")).toBeVisible();
          await expect(original.getByRole("link")).toHaveAttribute("href", `https://www.strava.com/segments/${rank.stravaSegmentId}`);
        }
        if (!segment.matched) {
          await expect(row).toContainText("Posted · not ridden");
          continue;
        }
        const time = segment.stats.elapsedSeconds;
        const displayedTime = Math.floor(time / 60) + ":" + String(time % 60).padStart(2, "0");
        await expect(row.locator(".segment-stat")).toContainText(`${different ? "Mapped segment time" : "Strava time"} ${displayedTime}`);
        const control = group.getByRole("button", { name: new RegExp(segment.campLabel) });
        await control.focus();
        await control.press("Enter");
        await expect(page.getByRole("tab", { name: "Rides", exact: true })).toHaveAttribute("aria-selected", "true");
        const card = guide.locator(".selection-card--segment");
        await expect(card.getByRole("heading", { name: segment.campLabel, exact: true })).toBeFocused();
        await expect(card.locator("dt")).toHaveText(["Time", "Distance", "Gain", "Avg grade", "Avg power", "Avg HR"]);
        const stats = segment.stats;
        const fmt = (value, decimals) => value.toLocaleString("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        await expect(card.locator("dd")).toHaveText([
          `${Math.floor(stats.elapsedSeconds / 60)}:${String(stats.elapsedSeconds % 60).padStart(2, "0")}`,
          `${fmt(stats.distanceKm, 2)} km`, `${fmt(stats.elevationGainM, 0)} m`, `${fmt(stats.averageGradePct, 1)}%`,
          `${fmt(stats.averagePowerW, 0)} W`, `${fmt(stats.averageHeartRateBpm, 0)} bpm`,
        ]);
        await expect(card.getByRole("link")).toHaveAttribute("href", segment.stravaUrl);
        await expect(page.locator(`.fallback-segment[data-segment-id="${segment.segmentId}"]`)).toHaveClass(/is-selected/);
        const points = ride.telemetrySamples.filter(p => p.segmentId === segment.segmentId);
        const band = page.locator(".profile-segment-band");
        await expect(band).toHaveCount(1);
        const boundsKm = await band.evaluate((band, maxKm) => {
          const axis = band.ownerSVGElement.querySelectorAll(".profile-axis text");
          const left = Number(axis[0].getAttribute("x"));
          const width = Number(axis[1].getAttribute("x")) - left;
          const x = Number(band.getAttribute("x"));
          return [(x - left) / width * maxKm, (x + Number(band.getAttribute("width")) - left) / width * maxKm];
        }, maxKm);
        expect(boundsKm[0]).toBeCloseTo(points[0].distanceKm, 3);
        expect(boundsKm[1]).toBeCloseTo(points.at(-1).distanceKm, 3);
        if (segment.campLabel === "La Creueta") {
          expect(boundsKm[0]).toBeCloseTo(33.47, 2);
          expect(boundsKm[1]).toBeCloseTo(36.77, 2);
        }
      }
    }
  });
}

test("conflicting incoming links, same-ride Back and Forward, and the week index", async ({ page }) => {
  await page.goto("/map/#segment=segment-10&ride=ride-1&point=ride-6-t0000&tab=rides");
  const guide = page.locator("#guide-content");
  await expect(guide.locator(".selection-card h3").first()).toHaveText("Cap de Formentor");
  await expect(guide.locator(".selection-card--segment")).toHaveCount(0);
  await guide.locator('[data-segment-id="segment-16"]').click();
  await guide.locator('[data-segment-id="segment-17"]').click();
  await page.goBack();
  await expect(guide.locator(".selection-card--segment h3")).toHaveText("La Creueta");
  await expect(guide.locator(".selection-card--segment h3")).toBeFocused();
  await page.goForward();
  await expect(guide.locator(".selection-card--segment h3")).toHaveText("Mirador de la Victoria");
  await page.goto("/map/#segment=segment-02&ride=ride-1&tab=segments");
  await expect(guide.locator(".selection-card--segment")).toHaveCount(0);
  await expect(guide.locator(".segment-group")).toHaveCount(6);
  await guide.locator('[data-segment-id="segment-10"]').click();
  await expect(page.getByRole("tab", { name: "Climbs" })).toHaveAttribute("aria-selected", "true");
  await expect(guide.locator(".selection-card--segment h3")).toHaveText("Puig Major");
});

test("profile coordinate conversion and sample controls track the selected sample", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/map/#segment=segment-16&tab=rides");
  const ride = snapshot.rides.find(r => r.rideId === "ride-6");
  const index = ride.telemetrySamples.findIndex(p => p.segmentId === "segment-16") - 1;
  const point = ride.telemetrySamples[index];
  const profile = page.locator(".profile-chart");
  await profile.scrollIntoViewIfNeeded();
  const click = await profile.evaluate((svg, fraction) => {
    const axis = svg.querySelectorAll(".profile-axis text");
    const left = Number(axis[0].getAttribute("x"));
    const right = Number(axis[1].getAttribute("x"));
    const screen = new DOMPoint(left + (right - left) * fraction, 45).matrixTransform(svg.getScreenCTM());
    return { x: screen.x, y: screen.y };
  }, point.distanceKm / ride.telemetrySamples.at(-1).distanceKm);
  await page.mouse.click(click.x, click.y);
  await expect(page).toHaveURL(new RegExp(point.sampleId));
  expect(new URL(page.url()).hash).not.toContain("segment=");
  const next = page.getByRole("button", { name: "Next published telemetry sample" });
  await next.focus();
  const initialTop = await page.evaluate(() => window.scrollY);
  await next.press("Enter");
  await expect(next).toBeFocused();
  await expect(page).toHaveURL(/segment=segment-16/);
  expect(await page.evaluate(() => window.scrollY)).toBe(initialTop);
  await profile.focus();
  await profile.press("ArrowLeft");
  await expect(profile).toBeFocused();
  await expect(page).toHaveURL(new RegExp(point.sampleId));
  expect(new URL(page.url()).hash).not.toContain("segment=");
});

async function camera(page) {
  return page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get("map")?.split(",").map(Number) ?? null);
}

test("saved camera and point framing survive immediate moves and Back/Forward", async ({ page }) => {
  const { serveMap } = await import("./fixtures/map.mjs");
  await serveMap(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const saved = [2.95, 39.81, 12, 14, 18];
  const point = snapshot.rides[3].telemetrySamples.find(p => p.segmentId === "segment-10");
  await page.goto(`/map/#point=${point.sampleId}&tab=rides&terrain=2d&map=${saved}`);
  await expect(page.locator("#map-panel")).toHaveAttribute("data-map-ready", "true", { timeout: 25_000 });
  await page.locator(".maplibregl-ctrl-zoom-in").click();
  await expect.poll(() => camera(page)).toEqual([saved[0], saved[1], 13, saved[3], saved[4]]);
  await page.locator('#guide-content [data-segment-id="segment-06"]').click();
  await expect.poll(async () => (await camera(page))?.[2]).toBeGreaterThan(11);
  const effortCamera = await camera(page);
  expect(effortCamera).not.toEqual([saved[0], saved[1], 13, saved[3], saved[4]]);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`point=${point.sampleId}`));
  expect(await camera(page)).toEqual([saved[0], saved[1], 13, saved[3], saved[4]]);
  await page.goForward();
  expect(await camera(page)).toEqual(effortCamera);
  await page.goto(`/map/#point=${point.sampleId}&tab=rides&terrain=2d`);
  await expect(page.locator("#map-panel")).toHaveAttribute("data-map-ready", "true", { timeout: 25_000 });
  await page.locator('#guide-content [data-segment-id="segment-06"]').click();
  await page.goBack();
  await page.locator(".maplibregl-ctrl-zoom-in").click();
  await expect.poll(async () => (await camera(page))?.[2]).toBeGreaterThan(13);
  const actual = await camera(page);
  expect(actual[0]).toBeCloseTo(point.coordinate[0], 4);
  expect(actual[1]).toBeCloseTo(point.coordinate[1], 4);
});

test("interrupted camera moves cannot overwrite another effort's history entry", async ({ page }) => {
  const { serveMap } = await import("./fixtures/map.mjs");
  await serveMap(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/map/#ride=ride-4&tab=rides&terrain=2d");
  await expect(page.locator("#map-panel")).toHaveAttribute("data-map-ready", "true", { timeout: 25_000 });
  await page.evaluate(() => {
    for (const id of ["segment-06", "segment-07", "segment-10"]) {
      document.querySelector(`#guide-content [data-segment-id="${id}"]`).click();
    }
  });
  await expect.poll(async () => (await camera(page))?.[2]).toBeGreaterThan(10);
  const finalCamera = await camera(page);
  await page.goBack();
  expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("segment")).toBe("segment-07");
  expect(await camera(page)).toBeNull();
  await page.locator(".maplibregl-ctrl-zoom-in").click();
  await expect.poll(async () => (await camera(page))?.[2]).toBeGreaterThan(11);
  const restored = await camera(page);
  const coords = snapshot.segments.find(s => s.segmentId === "segment-07").geometry.coordinates;
  for (const dim of [0, 1]) {
    const axis = coords.map(c => c[dim]);
    expect(restored[dim]).toBeGreaterThanOrEqual(Math.min(...axis) - 0.005);
    expect(restored[dim]).toBeLessThanOrEqual(Math.max(...axis) + 0.005);
  }
  await page.goForward();
  expect(await camera(page)).toEqual(finalCamera);
});
