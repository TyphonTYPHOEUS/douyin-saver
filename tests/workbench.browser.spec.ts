import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(".browser-test/ui-fixtures");
const ffmpeg = process.env.TEST_FFMPEG || (existsSync("/Applications/VideoFusion-macOS.app/Contents/Resources/ffmpeg")
  ? "/Applications/VideoFusion-macOS.app/Contents/Resources/ffmpeg" : "ffmpeg");
const videos: Buffer[] = [];
const musicPath = path.join(directory, "music.wav");
function generate(args: string[]) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr.toString());
}
test.beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  const listing = spawnSync(ffmpeg, ["-hide_banner", "-encoders"]).stdout.toString();
  const encoder = listing.includes("libx264") ? "libx264" : "h264_videotoolbox";
  for (const [index, color] of ["red", "green", "blue", "yellow", "magenta"].entries()) {
    const filename = path.join(directory, `${index + 1}.mp4`);
    generate(["-f", "lavfi", "-i", `color=c=${color}:s=90x160:r=30:d=0.3`, "-c:v", encoder, "-pix_fmt", "yuv420p", "-b:v", "1M", filename]);
    videos[index] = await readFile(filename);
  }
  generate(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1", "-c:a", "pcm_s16le", musicPath]);
});

test.beforeEach(async ({ page }) => {
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["localhost", "127.0.0.1"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.route("**/api/parse", async route => {
    const body = route.request().postDataJSON();
    const contentId = String(body.url).match(/\d+\/?$/)![0].replace("/", "");
    const index = Number(contentId) - 1;
    await route.fulfill({ json: { status: "ready", video: { contentId, title: `测试作品${contentId}`, author: "fixture", width: 90, height: 160, duration: 0.3, bytes: videos[index].byteLength, watermark: null, mediaToken: contentId } } });
  });
  await page.route("**/api/media?*", route => {
    const id = Number(new URL(route.request().url()).searchParams.get("token"));
    return route.fulfill({ body: videos[id - 1], contentType: "video/mp4" });
  });
  await page.goto("/");
  // Server-rendered navigation is visible before React attaches its handlers.
  await expect(page.locator(".edit-compose button.primary")).toBeEnabled();
  await page.getByRole("button", { name: "自动剪辑", exact: true }).click();
  await expect(page.locator("#edit-name")).toBeVisible();
});

const links = (ids: number[]) => ids.map(id => `https://www.douyin.com/video/${id}`).join("\n");

test("UI automatically renders after missing sources arrive, saves, reuses files and restores metadata only", async ({ page }) => {
  let mediaRequests = 0;
  page.on("request", request => { if (request.url().includes("/api/media?")) mediaRequests++; });
  await page.getByLabel("成片名称", { exact: true }).fill("../我的作品");
  await page.locator("#edit-links").fill(links([1, 2]));
  await page.getByRole("button", { name: "建立批次", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(musicPath);
  await expect(page.getByText("还需选择 2 个素材。", { exact: false })).toBeVisible();
  expect(mediaRequests).toBe(0);
  await page.locator("#edit-links").fill(links([3, 4]));
  await page.getByRole("button", { name: /将这些链接补充到/ }).click();
  const save = page.getByRole("button", { name: "保存成片", exact: true });
  await expect(save).toBeVisible({ timeout: 90_000 });
  expect(mediaRequests).toBe(4);
  const downloadPromise = page.waitForEvent("download");
  await save.click();
  expect((await downloadPromise).suggestedFilename()).toBe("_我的作品.mp4");
  await expect(page.getByText("已发起浏览器保存，请在浏览器下载列表中确认文件。", { exact: true })).toBeVisible();

  // A second named batch must use the same four checked source Blobs.
  await page.getByLabel("成片名称", { exact: true }).fill("复用素材");
  await page.locator("#edit-links").fill(links([1, 2, 3, 4]));
  await page.getByRole("button", { name: "建立批次", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(musicPath);
  await expect(save).toBeVisible({ timeout: 90_000 });
  expect(mediaRequests).toBe(4);
  const stored = await page.evaluate(() => localStorage.getItem("douyin-saver.edits.v1")!);
  expect(stored).not.toContain("blob:");
  expect(stored).not.toContain("mediaToken");
  expect(stored).not.toContain("temporaryFile");
  await page.reload();
  await expect(page.locator(".edit-compose button.primary")).toBeEnabled();
  await page.getByRole("button", { name: "自动剪辑", exact: true }).click();
  await expect(page.getByText("刷新后需重新准备素材并选择配乐，已保存的成片不受影响。", { exact: true })).toBeVisible();
  await expect(save).toHaveCount(0);
  expect(mediaRequests).toBe(4);
  await page.screenshot({ path: ".browser-test/editor-history.png", fullPage: true });
});

test("UI never silently picks the first four when more than four works are supplied", async ({ page }) => {
  let mediaRequests = 0;
  page.on("request", request => { if (request.url().includes("/api/media?")) mediaRequests++; });
  await page.getByLabel("成片名称", { exact: true }).fill("明确选片");
  await page.locator("#edit-links").fill(links([1, 2, 3, 4, 5]));
  await page.getByRole("button", { name: "建立批次", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(musicPath);
  await expect(page.getByText("请明确选择四个不同作品", { exact: true })).toBeVisible();
  await expect(page.getByText("已选 0/4 个位置", { exact: false })).toBeVisible();
  expect(mediaRequests).toBe(0);
  await expect(page.getByRole("button", { name: "保存成片", exact: true })).toHaveCount(0);
});

test("UI retry reparses an expired media ticket and retains successfully received sources", async ({ page }) => {
  let expired = false;
  let parses = 0;
  page.on("request", request => {
    if (request.url().endsWith("/api/parse") && String(request.postDataJSON()?.url).endsWith("/2")) parses++;
  });
  await page.route("**/api/media?token=2", route => {
    if (!expired) {
      expired = true;
      return route.fulfill({ status: 401, json: { error: "测试票据已过期，请重新解析。", code: "EXPIRED_TOKEN", serviceBlocked: false } });
    }
    return route.fulfill({ body: videos[1], contentType: "video/mp4" });
  });
  await page.getByLabel("成片名称", { exact: true }).fill("过期后恢复");
  await page.locator("#edit-links").fill(links([1, 2, 3, 4]));
  await page.getByRole("button", { name: "建立批次", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(musicPath);
  await expect(page.getByText("测试票据已过期，请重新解析。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重试剪辑", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存成片", exact: true })).toBeVisible({ timeout: 30_000 });
  expect(parses).toBe(2);
});
