import { test, expect } from "@playwright/test";

const STUDY_RULE = "I'm studying. Show programming and data structures but block distractors, lofi, or music.";

function ytp(testid) {
  return `[data-testid="${testid}"]`;
}
async function applyRule(page, rule) {
  await page.evaluate((r) => window.__ytp.applyRule(r), rule);
}
async function attrOf(page, testid) {
  return page.getAttribute(ytp(testid), "data-ytp");
}

test.describe("Home / legacy markup", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!window.__ytp);
  });

  test("scenario 1: study rule shows CS, hides music/lofi/routine", async ({ page }) => {
    await applyRule(page, STUDY_RULE);
    await expect.poll(() => attrOf(page, "lofiBeats01")).toBe("hidden");
    expect(await attrOf(page, "taylorSwt1x")).toBe("hidden");
    expect(await attrOf(page, "morningRt01")).toBe("hidden");
    expect(await attrOf(page, "graphAlgo01")).not.toBe("hidden");
    expect(await attrOf(page, "linuxProc01")).not.toBe("hidden");
  });

  test("scenario 3: provider garbage → every card stays visible", async ({ page }) => {
    await page.evaluate(() => window.__ytp.setFailMode("garbage"));
    await applyRule(page, STUDY_RULE);
    // Structural/strong-term hides may still apply, but ambiguous cards stay visible.
    await expect.poll(() => attrOf(page, "lofiBeats01")).not.toBe("hidden");
    expect(await attrOf(page, "morningRt01")).not.toBe("hidden");
  });

  test("scenario 4: context invalidated removes all data-ytp attributes", async ({ page }) => {
    await applyRule(page, STUDY_RULE);
    await expect.poll(() => attrOf(page, "lofiBeats01")).toBe("hidden");
    await page.evaluate(() => window.__ytp.invalidate());
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll("[data-ytp]").length))
      .toBe(0);
  });

  test("scenario 5: recycled element is re-evaluated", async ({ page }) => {
    await applyRule(page, STUDY_RULE);
    await expect.poll(() => attrOf(page, "graphAlgo01")).not.toBe("hidden");
    await page.evaluate(() => window.__fixture.recycle()); // now an official music video
    await expect.poll(() => attrOf(page, "graphAlgo01")).toBe("hidden");
  });

  test("late hydration: skeleton is classified after its title fills in", async ({ page }) => {
    await applyRule(page, STUDY_RULE);
    await page.evaluate(() => window.__fixture.hydrate());
    await expect.poll(() => attrOf(page, "hydrated001")).toBe("hidden"); // music, hidden once hydrated
  });

  test("scenario 6: 200-card burst is all handled, music cards hidden", async ({ page }) => {
    await applyRule(page, STUDY_RULE);
    await page.evaluate(() => { for (let i = 0; i < 10; i++) window.__fixture.burst(20); });
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('ytd-rich-item-renderer[data-ytp="hidden"]').length))
      .toBeGreaterThan(150); // the 200 "Official Music Video" burst cards hide via baseline
  });

  test("scenario 7: typing in the control does not reach document key handlers", async ({ page }) => {
    await page.evaluate(() => {
      window.__k = 0;
      document.addEventListener("keydown", (e) => { if (e.key === "k") window.__k++; });
    });
    await page.locator(".fab").click(); // open the panel
    await page.locator("input.rule").focus();
    await page.locator("input.rule").pressSequentially("kkk");
    expect(await page.evaluate(() => window.__k)).toBe(0);
  });
});

test.describe("Watch sidebar / lockup markup", () => {
  test("scenario 1 works against lockup view-model markup too", async ({ page }) => {
    await page.goto("/watch");
    await page.waitForFunction(() => !!window.__ytp);
    await applyRule(page, STUDY_RULE);
    await expect.poll(() => attrOf(page, "lofiBeats01")).toBe("hidden");
    expect(await attrOf(page, "graphAlgo01")).not.toBe("hidden");
    expect(await attrOf(page, "linuxProc01")).not.toBe("hidden");
  });

  test("on-card ♪ badge hides an AI-opaque art-track even when the AI is down", async ({ page }) => {
    await page.goto("/watch");
    await page.waitForFunction(() => !!window.__ytp);
    await page.evaluate(() => window.__ytp.setFailMode("garbage")); // no help from the model
    await applyRule(page, STUDY_RULE);
    // "FLOWER DAY FUNK" is opaque to the baseline, but carries the music badge → hidden structurally.
    await expect.poll(() => attrOf(page, "flowerFunk1")).toBe("hidden");
    // Control: an ambiguous non-music card has no badge, so it stays visible when the AI fails open.
    expect(await attrOf(page, "morningRt01")).not.toBe("hidden");
  });
});
