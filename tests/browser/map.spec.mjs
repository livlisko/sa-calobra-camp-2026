import { test, expect } from "@playwright/test";
import { emptyRoadTile, serveMap } from "./fixtures/map.mjs";

const closeUp = "/map/#ride=ride-6&segment=segment-16&terrain=2d&tab=segments&map=3.13340,39.92918,15.00,0.0,0.0";

async function expectRenderer(page, live) {
  await expect(page.locator("#map")).toHaveJSProperty("inert", !live, { timeout: 25_000 });
  await expect(page.locator("#fallback")).toHaveJSProperty("inert", live);
  await expect(page.locator("#fallback")).toHaveAttribute("aria-hidden", String(live));
}

function camera(page) {
  return new URLSearchParams(new URL(page.url()).hash.slice(1)).get("map")?.split(",").map(Number);
}

test.describe.configure({ timeout: 60_000 });
test.use({ reducedMotion: "reduce", viewport: { width: 1024, height: 720 } });

test("close-up link opens live, keeps its camera, and tolerates a missing tile", async ({ page }) => {
  let failNext = true;
  let failures = 0;
  await serveMap(page, { baseTile: (route, respond) => {
    if (!failNext) return respond();
    failNext = false;
    failures++;
    return route.fulfill({ status: 503 });
  } });
  await page.goto(closeUp);
  await expectRenderer(page, true);
  expect(failures).toBe(1);
  failNext = true;
  await expect(page.locator("#guide-title")).toHaveText("La Creueta");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(() => camera(page)?.[2]).toBeCloseTo(16, 1);
  expect(camera(page)[0]).toBeCloseTo(3.13340, 4);
  expect(camera(page)[1]).toBeCloseTo(39.92918, 4);
  await expect.poll(() => failures).toBe(2);
  await expectRenderer(page, true);
});

test("leaving cached coverage during a provider outage restores the SVG and retries the selected view", async ({ page }) => {
  let provider = "healthy";
  const failures = new Set();
  let successfulRetries = 0;
  await serveMap(page, { baseTile: (route, respond) => {
    const url = route.request().url();
    if (provider === "healthy") return respond();
    if (provider === "recovering" && failures.has(url)) {
      successfulRetries++;
      return respond();
    }
    failures.add(url);
    return route.fulfill({ status: 503 });
  } });
  await page.goto(closeUp.replace("15.00", "16.00"));
  await expectRenderer(page, true);
  provider = "unavailable";
  await page.locator('#guide-content [data-segment-id="segment-05"]').click();
  await expect(page.locator("#guide-title")).toHaveText("Sant Salvador");
  await expect.poll(() => failures.size).toBeGreaterThan(1);
  await expectRenderer(page, false);
  await expect(page.locator("#fallback").getByRole("button", { name: "Select Sant Salvador segment" })).toHaveAttribute("aria-pressed", "true");

  // The provider can recover without an offline/online event in the browser.
  provider = "recovering";
  await expectRenderer(page, true);
  expect(successfulRetries).toBeGreaterThan(0);
  expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("segment")).toBe("segment-05");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(() => camera(page)?.[1]).toBeCloseTo(39.46, 1);
  expect(camera(page)[0]).toBeCloseTo(3.18, 1);
});

test("vector 404 placeholders keep the SVG active until genuine vector tiles arrive", async ({ page }) => {
  let available = false;
  let repeatedFailures = 0;
  let validResponses = 0;
  const failed = new Set();
  await serveMap(page, { vector: true, baseTile: (route, respond) => {
    if (available) {
      validResponses++;
      return respond();
    }
    const url = route.request().url();
    if (failed.has(url)) repeatedFailures++;
    failed.add(url);
    return route.fulfill({ status: 404 });
  } });
  await page.goto(closeUp);
  await expect.poll(() => repeatedFailures, { timeout: 25_000 }).toBeGreaterThan(0);
  await expect(page.locator("#map")).toHaveJSProperty("inert", true);
  await expect(page.locator("#fallback")).toHaveJSProperty("inert", false);
  await expect(page.locator("#fallback").getByRole("button", { name: "Select La Creueta segment" })).toHaveAttribute("aria-pressed", "true");
  available = true;
  await expectRenderer(page, true);
  expect(validResponses).toBeGreaterThan(0);
  await expect(page.locator("#guide-title")).toHaveText("La Creueta");
});

test("successfully decoded vector basemap tiles can contain zero features", async ({ page }) => {
  await serveMap(page, { vector: true, baseTile: (route) =>
    route.fulfill({ contentType: "application/x-protobuf", body: emptyRoadTile }) });
  await page.goto(closeUp);
  await expectRenderer(page, true);
});

test("slow tiles keep the static map operable and recover with its latest selection", async ({ page }) => {
  const tiles = Promise.withResolvers();
  let requested = false;
  await serveMap(page, { baseTile: async (_route, respond) => {
    requested = true;
    await tiles.promise;
    return respond();
  } });
  try {
    await page.goto(closeUp);
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator("#fallback")).toHaveJSProperty("inert", false);
    const fallbackSegment = page.locator("#fallback").getByRole("button", { name: "Select Tofla segment" });
    await fallbackSegment.press("Enter");
    await expect(page.locator("#guide-title")).toHaveText("Tofla");
    await expect(fallbackSegment).toHaveAttribute("aria-pressed", "true");
  } finally {
    tiles.resolve();
  }
  await expectRenderer(page, true);
  await expect(page.locator("#guide-title")).toHaveText("Tofla");
});

test("a failed style recovers on reconnection", async ({ page }) => {
  let requests = 0;
  await serveMap(page, { styleRequest: (route, style) =>
    ++requests === 1 ? route.fulfill({ status: 503 }) : route.fulfill({ json: style }) });
  await page.goto(closeUp);
  await expect(page.locator("#map-status")).toContainText(/unavailable/i);
  await page.locator("#fallback").getByRole("button", { name: "Select Tofla segment" }).press("Enter");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectRenderer(page, true);
  await expect(page.locator("#guide-title")).toHaveText("Tofla");
});

test("a terrain provider failure keeps live routes usable and retries relief on reconnection", async ({ page }) => {
  await serveMap(page);
  const demURL = "https://tiles.mapterhorn.com/tilejson.json";
  const unavailable = (route) => route.fulfill({ status: 503 });
  await page.route(demURL, unavailable);
  await page.goto(closeUp);
  await expectRenderer(page, true);
  await expect(page.locator("#map-status")).toContainText("Terrain data could not load");
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeEnabled();
  await page.unroute(demURL, unavailable);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#map-status")).toHaveText("Live route map ready");
  await expectRenderer(page, true);
});

for (const mode of ["2d", "3d"]) {
  test(`lost ${mode} WebGL returns controls to the static map and restores the selected climb`, async ({ page }) => {
    if (mode === "3d") await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await serveMap(page);
    await page.goto(closeUp.replace("terrain=2d", `terrain=${mode}`));
    await expectRenderer(page, true);
    await page.evaluate(() => {
      const gl = document.querySelector("#map canvas").getContext("webgl2");
      window.testContextLoss = gl.getExtension("WEBGL_lose_context");
      window.testContextLoss.loseContext();
    });
    await expectRenderer(page, false);
    await page.locator("#fallback").getByRole("button", { name: "Select Sant Salvador segment" }).press("Enter");
    await expect(page.locator("#guide-title")).toHaveText("Sant Salvador");
    await page.evaluate(() => window.testContextLoss.restoreContext());
    await expectRenderer(page, true);
    await expect(page.locator("#guide-title")).toHaveText("Sant Salvador");
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(() => camera(page)?.[1]).toBeCloseTo(39.46, 1);
    expect(camera(page)[0]).toBeCloseTo(3.18, 1);
    expect(errors).toEqual([]);
  });
}

test("without WebGL, a close-up link retains its selection and static controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const native = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      return kind === "webgl2" ? null : native.call(this, kind, ...args);
    };
  });
  await page.goto(closeUp);
  await expect(page.locator("#map-status")).toContainText("WebGL is unavailable");
  await expect(page.locator("#guide-title")).toHaveText("La Creueta");
  const target = page.locator("#fallback").getByRole("button", { name: "Select Sant Salvador segment" });
  // Paths need a real point on their stroke, not the centre of a bounding box.
  const hit = await target.evaluate((path) => {
    const length = path.getTotalLength();
    for (let fraction = 0; fraction <= 1; fraction += 0.025) {
      const point = path.getPointAtLength(length * fraction).matrixTransform(path.getScreenCTM());
      if (document.elementFromPoint(point.x, point.y) === path) return { x: point.x, y: point.y };
    }
    return null;
  });
  expect(hit).toBeTruthy();
  await page.mouse.click(hit.x, hit.y);
  await expect(target).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#guide-title")).toHaveText("Sant Salvador");
});
