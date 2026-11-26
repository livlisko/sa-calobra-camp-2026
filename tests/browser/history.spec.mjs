import { expect, test } from "@playwright/test";

const legacyKey = "mallorca-camp-segment-history-v1";
const compareUrl = "/map/#tab=compare&segment=segment-01";
const segmentKey = "strava:17911492@public-rider-trace-2026-v1";
const checkbox = (page) => page.getByRole("checkbox", { name: "Remember on this device" });
const count = (page, n) => expect(page.locator(".comparison-deck")).toHaveText(new RegExp(`^${n} confirmed personal`));
const forget = (page) => page.getByRole("button", { name: "Forget imported history…" }).click();
const adopt = (page) => page.getByRole("button", { name: "This published effort is mine…" }).click();
const day = "2026-10-18";
const start = day + "T08:00:00.125Z";
const next = day + "T12:00:00.125Z";

test.beforeEach(async ({ context }) => {
  await context.route(/https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  await context.addInitScript(() => {
    window.confirm = () => true;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
      return kind.includes("webgl") ? null : getContext.call(this, kind, ...args);
    };
    const NativeWorker = window.Worker;
    // Only the FIT worker is replaced. Exercise the built UI, worker protocol and real IndexedDB.
    window.Worker = class extends EventTarget {
      constructor(url, options) {
        super();
        if (options?.name !== "mallorca-history-import") return new NativeWorker(url, options);
      }
      postMessage({ requestId, sourceId, bytes, catalog }) {
        const fixture = JSON.parse(new TextDecoder().decode(bytes));
        const send = (message) => this.dispatchEvent(new MessageEvent("message", { data: { requestId, sourceId, ...message } }));
        const complete = () => {
          send({ type: "progress", phase: "finalizing" });
          const segment = catalog.segments.find((s) => s.stravaSegmentId === "17911492");
          const startMs = Date.parse(fixture.start);
          const endMs = startMs + (fixture.durationMs ?? 709000);
          const effort = {
            effortId: sourceId, sourceId, campLabel: segment.campLabel,
            segmentKey: "strava:17911492@" + segment.boundaryVersion,
            startedAtIso: fixture.start, startTimestampMs: startMs, endTimestampMs: endMs,
            elapsedSeconds: Math.round((endMs - startMs) / 1000), averagePowerW: fixture.power ?? 200,
            averageHeartRateBpm: null, matchStatus: "confirmed", matchScore: 1, matchReasons: [],
            coverage: { power: 1, heartRate: 0, cadence: 0, altitude: 0 }, quality: "partial",
          };
          send({ type: "result", result: { sourceId, parser: "fit-file-parser", efforts: [effort], warnings: [] } });
        };
        if (fixture.delay) window.finishImport = complete;
        else complete();
      }
      terminate() {}
    };
  });
});

async function open(page) {
  await page.goto(compareUrl);
  await expect(checkbox(page)).toBeEnabled();
}
async function add(page, options) {
  await page.locator('input[type=file]').setInputFiles({
    name: "synthetic.fit", mimeType: "application/octet-stream", buffer: Buffer.from(JSON.stringify(options)),
  });
  if (options.delay) await page.waitForFunction(() => !!window.finishImport);
  else await expect(page.getByText(/Reading .* locally/)).toHaveCount(0);
}
async function decision(page, name) {
  await page.getByRole("button", { name: /^Review \d/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

for (const adoptionFirst of [true, false]) {
  test(`published attempt reconciles in either order, adoptionFirst=${adoptionFirst}`, async ({ page }) => {
    await open(page);
    await checkbox(page).check();
    if (adoptionFirst) await adopt(page);
    await add(page, { start });
    if (!adoptionFirst) await adopt(page);
    await count(page, 1);
    await decision(page, "Same ascent");
    await expect(page.getByRole("button", { name: /^Review \d/ })).toHaveCount(0);
    await page.reload();
    await count(page, 1);
    await expect(page.getByRole("button", { name: /^Review \d/ })).toHaveCount(0);
    await add(page, { start, power: 250 });
    await count(page, 1);
    await expect(page.getByRole("button", { name: /^Review \d/ })).toHaveCount(0);
    await add(page, { start: next });
    await count(page, 2);
  });
}
test("separate equal-duration efforts and a remembered separate reference decision", async ({ page }) => {
  await open(page);
  await checkbox(page).check();
  await add(page, { start });
  await adopt(page);
  await decision(page, "Separate ascents");
  await count(page, 2);
  await page.reload();
  await count(page, 2);
  await add(page, { start, power: 300 });
  await count(page, 2);
  await add(page, { start: next });
  await decision(page, "Separate ascents");
  await count(page, 3);
});

test("two tabs independently add and reopening preserves both", async ({ page, context }) => {
  const other = await context.newPage();
  await Promise.all([open(page), open(other)]);
  await checkbox(page).check();
  await expect(checkbox(other)).toBeChecked();
  await Promise.all([add(page, { start }), add(other, { start: next })]);
  await count(page, 2);
  await count(other, 2);
  await other.reload();
  await count(other, 2);
});
test("reviewing a publication preserves both timed ascents until all decisions are made", async ({ page }) => {
  await open(page);
  await adopt(page);
  await add(page, { start, power: 205 });
  await expect(page.getByRole("button", { name: "Review 1 match", exact: true })).toBeVisible();
  await add(page, { start: next, power: 235 });
  await count(page, 2);
  const ledger = page.locator(".comparison-attempt-list");
  await expect(ledger).toContainText("235 W");
  await page.getByRole("button", { name: "Review 2 matches" }).click();
  await page.getByRole("dialog").getByRole("listitem").filter({ hasText: "10:00:00" })
    .getByRole("button", { name: "Separate ascents" }).click();
  await expect(ledger).toContainText("235 W");
  await expect(ledger).toContainText("205 W");
  await count(page, 2);
  await decision(page, "Separate ascents");
  await count(page, 3);
});
for (const erase of ["forget", "opt-out"]) {
  for (const commitFirst of [true, false]) {
    test(`two tabs race add with ${erase}, add commits first=${commitFirst}`, async ({ page, context }) => {
      const other = await context.newPage();
      await Promise.all([open(page), open(other)]);
      await checkbox(page).check();
      await expect(checkbox(other)).toBeChecked();
      await add(page, { start });
      await count(other, 1);
      await add(other, { start: next, delay: true });
      if (commitFirst) {
        await other.evaluate(() => window.finishImport());
        await count(page, 2);
      }
      if (erase === "forget") await forget(page);
      else await checkbox(page).uncheck();
      await expect(checkbox(other)).not.toBeChecked();
      if (!commitFirst) await other.evaluate(() => window.finishImport());
      await count(other, erase === "forget" ? 0 : 2);
      await other.reload();
      await count(other, 0);
      await expect(checkbox(other)).not.toBeChecked();
    });
  }
}
test("first session-only pending import can be forgotten", async ({ page }) => {
  await open(page);
  await add(page, { start, delay: true });
  await forget(page);
  await page.evaluate(() => window.finishImport());
  await count(page, 0);
  await expect(page.getByText(/Reading .* locally/)).toHaveCount(0);
  await add(page, { start: next });
  await count(page, 1);
  await page.reload();
  await count(page, 0);
});
test("blocked storage leaves imports working and describes an unverified erase", async ({ page }) => {
  await page.addInitScript(() => {
    for (const key of ["localStorage", "indexedDB"]) Object.defineProperty(window, key, { get() { throw new DOMException("Blocked", "SecurityError"); } });
  });
  await open(page);
  await add(page, { start });
  await count(page, 1);
  await checkbox(page).click();
  await expect(page.getByText(/could not save|storage is unavailable/i).first()).toBeVisible();
  await forget(page);
  await count(page, 0);
  await expect(page.getByText(/could not erase/i).first()).toBeVisible();
});
test("failed erase reports the failure and can be retried", async ({ page }) => {
  await open(page);
  await checkbox(page).check();
  await add(page, { start });
  await count(page, 1);
  await page.evaluate(() => {
    const clear = IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.clear = function() {
      IDBObjectStore.prototype.clear = clear;
      const result = clear.call(this);
      this.transaction.abort();
      return result;
    };
  });
  await forget(page);
  await expect(page.getByText(/could not erase/i).first()).toBeVisible();
  await page.reload();
  await count(page, 1);
  await forget(page);
  await expect(page.locator(".comparison-import-controls .is-error")).toHaveCount(0);
  await count(page, 0);
  await page.reload();
  await count(page, 0);
});
test("migrates v1 once, preserving valid rows alongside damaged entries", async ({ page }) => {
  await page.addInitScript(({ legacyKey, segmentKey, start }) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem(legacyKey, JSON.stringify({ version: 1, efforts: [null, {
        effortId: "legacy-random-id", segmentId: "segment-01", segmentVersionKey: segmentKey,
        activityDate: start, elapsedSeconds: 709, averagePowerW: 211, averageHeartRateBpm: null,
        scope: "personal", source: "fit-derived", matchStatus: "confirmed",
      }] }));
      sessionStorage.setItem("seeded", "1");
    }
  }, { legacyKey, segmentKey, start });
  await open(page);
  await count(page, 1);
  await expect(checkbox(page)).toBeChecked();
  expect(await page.evaluate((key) => localStorage.getItem(key), legacyKey)).toBeNull();
  await add(page, { start });
  await count(page, 1);
  await decision(page, "Same ascent");
  await page.reload();
  await count(page, 1);
});

test("a missed Forget notification cannot recreate an effort after remembering is re-enabled", async ({ page, context }) => {
  await open(page);
  await checkbox(page).check();
  await add(page, { start });
  await count(page, 1);
  const other = await context.newPage();
  await other.addInitScript(() => {
    window.BroadcastChannel = class { postMessage() {} };
    window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
    document.addEventListener("visibilitychange", (event) => event.stopImmediatePropagation(), true);
  });
  await open(other);
  await count(other, 1);
  await add(other, { start: next, delay: true });
  await forget(page);
  await expect(checkbox(page)).not.toBeChecked();
  await checkbox(page).check();
  await expect(checkbox(page)).toBeChecked();
  await other.evaluate(() => window.finishImport());
  await count(other, 0);
  await other.reload();
  await count(other, 0);
  await expect(checkbox(other)).toBeChecked();
});

test("an import crossing opt-out and a later opt-in remains in its original tab", async ({ page, context }) => {
  await open(page);
  await checkbox(page).check();
  const other = await context.newPage();
  await open(other);
  await expect(checkbox(other)).toBeChecked();
  await add(other, { start, delay: true });
  await checkbox(page).uncheck();
  await expect(checkbox(other)).not.toBeChecked();
  await checkbox(page).check();
  await expect(checkbox(other)).toBeChecked();
  await other.evaluate(() => window.finishImport());
  await count(other, 1);
  await expect(other.getByText(/Some summaries or review decisions are available only in this tab/)).toBeVisible();
  await other.reload();
  await count(other, 0);
});

test("damaged legacy JSON can be cleared and does not break the atlas", async ({ page }) => {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem(key, "{");
      sessionStorage.setItem("seeded", "1");
    }
  }, legacyKey);
  await open(page);
  await expect(page.getByText(/Older history could not be read/)).toBeVisible();
  await forget(page);
  await expect(page.locator(".comparison-import-controls .is-error")).toHaveCount(0);
  await count(page, 0);
  await page.reload();
  await count(page, 0);
  await expect(page.getByText(/Older history could not be read/)).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), legacyKey)).toBeNull();
});

test("distinct precise ends survive identical starts and rounded elapsed time", async ({ page }) => {
  await open(page);
  await add(page, { start, durationMs: 709010.125 });
  await count(page, 1);
  await add(page, { start, durationMs: 709010.875 });
  await count(page, 2);
});

test("an aborted migration preserves the old copy for retry and never imports it twice", async ({ page }) => {
  const legacy = JSON.stringify({ version: 1, efforts: [{
    effortId: "older-timed-summary", segmentId: "segment-01", segmentVersionKey: segmentKey,
    activityDate: start, elapsedSeconds: 709, averagePowerW: 220, averageHeartRateBpm: null,
    scope: "personal", source: "fit-derived", matchStatus: "confirmed",
  }] });
  await page.addInitScript(({ legacyKey, legacy }) => {
    if (sessionStorage.getItem("attempted-migration")) return;
    sessionStorage.setItem("attempted-migration", "1");
    localStorage.setItem(legacyKey, legacy);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args) {
      const result = put.apply(this, args);
      if (this.name === "attempts") this.transaction.abort();
      return result;
    };
  }, { legacyKey, legacy });
  await open(page);
  await expect(page.getByText(/storage is unavailable/i)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), legacyKey)).toBe(legacy);
  await page.reload();
  await count(page, 1);
  await expect(checkbox(page)).toBeChecked();
  await forget(page);
  await count(page, 0);
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: legacyKey, value: legacy });
  await page.reload();
  await expect(checkbox(page)).toBeEnabled();
  await count(page, 0);
  await expect(checkbox(page)).not.toBeChecked();
});

test("Forget can erase an older copy even when its contents cannot be read", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "unreadable");
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function(item) {
      if (item === key) throw new DOMException("Read blocked", "SecurityError");
      return get.call(this, item);
    };
    window.hasOlderCopy = () => get.call(localStorage, key) !== null;
  }, legacyKey);
  await open(page);
  await expect(page.getByText(/storage is unavailable/i)).toBeVisible();
  await forget(page);
  await expect(page.locator(".comparison-import-controls .is-error")).toHaveCount(0);
  expect(await page.evaluate(() => window.hasOlderCopy())).toBe(false);
});

test("Compare keeps keyboard focus through selection, browser history and a dataset refresh", async ({ page }) => {
  await page.goto("/map/#segment=segment-10&tab=compare");
  const back = page.getByRole("button", { name: "All repeated climbs" });
  const heading = page.locator(".comparison-hero h3");
  await back.press("Enter");
  await expect(heading).toHaveText("Compare your camps");
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();

  await open(page);
  await add(page, { start });
  await add(page, { start: next });
  await count(page, 2);
  await back.press("Enter");
  await expect(heading).toBeFocused();
  const row = page.getByRole("button", { name: /Santa Magdalena, 2 attempts/ });
  await row.press("Enter");
  await expect(heading).toHaveText("Santa Magdalena");
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  const refresh = async () => {
    const old = await heading.elementHandle();
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    await expect.poll(() => old.evaluate(element => element.isConnected)).toBe(false);
    await old.dispose();
  };
  await refresh();
  await expect(heading).toBeFocused();
  const power = page.getByRole("button", { name: "Power", exact: true });
  await power.press("Enter");
  await expect(power).toHaveAttribute("aria-pressed", "true");
  await expect(power).toBeFocused();
  const baseline = page.getByRole("combobox");
  await baseline.focus();
  await baseline.selectOption("best");
  await refresh();
  await expect(baseline).toBeFocused();
  await expect(baseline).toHaveValue("best");
  await page.goBack();
  await expect(heading).toHaveText("1 repeated climb");
  await expect(heading).toBeFocused();
  await page.goForward();
  await expect(heading).toHaveText("Santa Magdalena");
  await expect(heading).toBeFocused();
});

for (const fallbackOnly of [false, true]) {
  test(`committed Forget reaches a tab with blocked metadata reads, storage-event only=${fallbackOnly}`, async ({ page, context }) => {
    await open(page);
    await checkbox(page).check();
    await adopt(page);
    const other = await context.newPage();
    if (fallbackOnly) await other.addInitScript(() => { window.BroadcastChannel = undefined; });
    await open(other);
    await count(other, 1);
    await add(other, { start, delay: true });
    // Hold delivery of an already completed database read across the erase.
    await other.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", { ...descriptor, set(handler) {
        if (this.mode !== "readonly") return descriptor.set.call(this, handler);
        Object.defineProperty(IDBTransaction.prototype, "oncomplete", descriptor);
        descriptor.set.call(this, (event) => { window.releaseRead = () => handler.call(this, event); });
      } });
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await other.waitForFunction(() => typeof window.releaseRead === "function");
    await other.evaluate(() => {
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function(...args) {
        if (this.name === "metadata") throw new DOMException("Denied", "SecurityError");
        return get.apply(this, args);
      };
      window.restoreReads = () => { IDBObjectStore.prototype.get = get; };
    });
    await forget(page);
    await count(other, 0);
    await expect(checkbox(other)).not.toBeChecked();
    await other.evaluate(() => window.releaseRead());
    await expect(other.getByText(/storage is unavailable/i)).toBeVisible();
    await other.evaluate(() => window.finishImport());
    await count(other, 0);
    await expect(other.getByText(/Reading .* locally/)).toHaveCount(0);
    await other.evaluate(() => {
      window.restoreReads();
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(other.getByText(/storage is unavailable/i)).toHaveCount(0);
  });
}

for (const blockBoth of [false, true]) {
  test(`an earlier Forget preserves a new session effort through read recovery, both stores blocked=${blockBoth}`, async ({ page, context }) => {
    await open(page);
    await checkbox(page).check();
    await adopt(page);
    await count(page, 1);
    await forget(page);
    await count(page, 0);
    await page.close();
    const other = await context.newPage();
    await other.addInitScript((blockBoth) => {
      const keys = blockBoth ? ["indexedDB", "localStorage"] : ["indexedDB"];
      for (const key of keys) {
        const getter = Object.getOwnPropertyDescriptor(window, key).get;
        Object.defineProperty(window, key, { configurable: true, get() {
          if (!window.storageRestored) throw new DOMException("Denied", "SecurityError");
          return getter.call(window);
        } });
      }
    }, blockBoth);
    await open(other);
    await expect(other.getByText(/storage is unavailable/i)).toBeVisible();
    await adopt(other);
    await count(other, 1);
    await other.evaluate(() => {
      window.storageRestored = true;
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(other.locator(".comparison-import-controls .is-error")).toHaveCount(0);
    await count(other, 1);
    await expect(checkbox(other)).not.toBeChecked();
  });
}

test("review dialog waits for the decision transaction before dismissing", async ({ page }) => {
  await open(page);
  await checkbox(page).check();
  await adopt(page);
  await add(page, { start });
  await page.getByRole("button", { name: /^Review \d/ }).click();
  const dialog = page.getByRole("dialog");
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", { ...descriptor, set(handler) {
      if (this.mode !== "readwrite") return descriptor.set.call(this, handler);
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", descriptor);
      descriptor.set.call(this, (event) => { window.acknowledgeDecision = () => handler.call(this, event); });
    } });
  });
  await dialog.getByRole("button", { name: "Same ascent" }).click();
  await page.waitForFunction(() => typeof window.acknowledgeDecision === "function");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Separate ascents" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Review later" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.acknowledgeDecision());
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await count(page, 1);
  await expect(page.getByRole("button", { name: /^Review \d/ })).toHaveCount(0);
});
