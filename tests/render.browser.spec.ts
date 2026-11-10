import { test, expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// All fixtures are synthesized locally. Tests never parse or download a real work.
const directory = path.resolve(".browser-test/fixtures");
const ffmpeg = process.env.TEST_FFMPEG || (existsSync("/Applications/VideoFusion-macOS.app/Contents/Resources/ffmpeg")
  ? "/Applications/VideoFusion-macOS.app/Contents/Resources/ffmpeg" : "ffmpeg");
const ffprobe = process.env.TEST_FFPROBE || (path.isAbsolute(ffmpeg)
  ? path.join(path.dirname(ffmpeg), "ffprobe") : "ffprobe");
type Fixtures = { videos: string[]; music: string; shortMusic: string };
let fixtures: Fixtures;

function run(binary: string, args: string[]): Buffer {
  const result = spawnSync(binary, args, { maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr.toString().slice(-3000)}`);
  return result.stdout;
}

function wave(seconds: number, frequency: number): Buffer {
  const count = Math.round(44_100 * seconds);
  const data = Buffer.alloc(44 + count * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(44_100, 24); data.writeUInt32LE(88_200, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(4096 * Math.sin(i * 2 * Math.PI * frequency / 44_100)), 44 + i * 2);
  return data;
}

test.beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  const encoders = run(ffmpeg, ["-hide_banner", "-encoders"]).toString();
  const encoder = encoders.includes("libx264") ? "libx264" : "h264_videotoolbox";
  const colors = ["red", "green", "blue", "yellow"];
  const durations = [0.4, 0.6, 0.8, 1];
  const sizes = ["90x160", "160x90", "90x160", "90x160"];
  const videos: string[] = [];
  for (let i = 0; i < 4; i++) {
    const file = path.join(directory, `panel-${i}.mp4`);
    const filters = i === 0 ? ["-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=magenta:t=fill:enable='gte(t,0.2)'"] : [];
    run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${colors[i]}:s=${sizes[i]}:r=30:d=${durations[i]}`,
      "-f", "lavfi", "-i", `sine=frequency=1200:sample_rate=44100:duration=${durations[i]}`,
      ...filters, "-c:v", encoder, "-pix_fmt", "yuv420p", "-b:v", "1M",
      "-c:a", "aac", "-t", String(durations[i]), "-movflags", "+faststart", file]);
    videos.push((await readFile(file)).toString("base64"));
  }
  const music = wave(1.5, 440);
  const shortMusic = wave(0.2, 440);
  await writeFile(path.join(directory, "music.wav"), music);
  fixtures = { videos, music: music.toString("base64"), shortMusic: shortMusic.toString("base64") };
});

async function openHarness(page: Page) {
  // Library chunks and generated files are served locally; no external service is needed.
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
  });
  // Isolate the media engine from application HMR: Vite can reload the workbench
  // when it optimizes a codec for the first time, destroying an in-flight render.
  // This test-only document is intercepted here and is never part of the app.
  await page.route(url => url.pathname === "/__render_test_harness__", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><html><head><title>Local media tests</title></head><body></body></html>",
  }));
  await page.goto("/__render_test_harness__");
}

test.beforeEach(async ({ page }) => { await openHarness(page); });

async function render(page: Page, data: Fixtures, mode: "render" | "short" | "corrupt" | "cancel" | "retain" = "render") {
  return page.evaluate(async ({ data, mode }) => {
    const modulePath = "/lib/edit/client.ts";
    const { renderBatch, cleanupRender } = await import(modulePath);
    const blob = (base64: string, type: string) => new Blob([Uint8Array.from(atob(base64), value => value.charCodeAt(0))], { type });
    const videos = data.videos.map(value => blob(value, "video/mp4"));
    if (mode === "corrupt") videos[1] = new Blob(["truncated"], { type: "video/mp4" });
    const music = new File([blob(mode === "short" ? data.shortMusic : data.music, "audio/wav")], "music.wav", { type: "audio/wav" });
    const phases: string[] = [];
    const controller = new AbortController();
    try {
      const result = await renderBatch({ id: crypto.randomUUID(), name: "Browser integration", videos, music }, (progress: { phase: string }) => {
        phases.push(progress.phase);
        if (mode === "cancel" && progress.phase === "rendering") controller.abort();
      }, controller.signal);
      if (mode === "retain") return { unexpectedSuccess: false, error: "", phases, temporaryFile: result.temporaryFile };
      if (mode !== "render") {
        await cleanupRender(result.temporaryFile);
        return { unexpectedSuccess: true, error: "", phases };
      }
      const video = document.createElement("video");
      const objectUrl = URL.createObjectURL(result.file);
      video.muted = true; video.src = objectUrl;
      await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("Cannot preview rendered file")); });
      const canvas = document.createElement("canvas");
      canvas.width = 1440; canvas.height = 2560;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const samples: number[][][] = [];
      for (const timestamp of [0.1, 0.3, 0.5, 0.983]) {
        await new Promise<void>(resolve => { video.onseeked = () => resolve(); video.currentTime = timestamp; });
        context.drawImage(video, 0, 0);
        samples.push([[360, 640], [1080, 640], [360, 1920], [1080, 1920], [1080, 100]].map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)));
      }
      URL.revokeObjectURL(objectUrl);
      const bytes = new Uint8Array(await result.file.arrayBuffer());
      let raw = "";
      for (let index = 0; index < bytes.length; index += 8192) raw += String.fromCharCode(...bytes.subarray(index, index + 8192));
      const output = { unexpectedSuccess: false, error: "", phases, samples, base64: btoa(raw),
        width: result.width, height: result.height, fps: result.fps, frames: result.frames,
        duration: result.duration, verification: result.verification, verifier: result.verifier, temporaryFile: result.temporaryFile };
      await cleanupRender(result.temporaryFile);
      return output;
    } catch (error) {
      return { unexpectedSuccess: false, error: error instanceof Error ? error.message : String(error), phases };
    }
  }, { data, mode });
}

function amplitude(pcm: Buffer, frequency: number): number {
  let re = 0, im = 0;
  const samples = pcm.length / 4;
  for (let index = 0; index < samples; index++) {
    const value = pcm.readFloatLE(index * 4);
    const angle = index * 2 * Math.PI * frequency / 44_100;
    re += value * Math.cos(angle); im += value * Math.sin(angle);
  }
  return 2 * Math.hypot(re, im) / samples;
}

function waveData(wav: Buffer): Buffer {
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    if (name === "data") return wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + length));
    offset += 8 + length + (length % 2);
  }
  throw new Error("Decoded audio did not contain WAV data");
}

test("renders a complete four-grid MP4 with loops, contain fitting and only the selected music", async ({ page }, testInfo) => {
  const uploads: string[] = [];
  page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) uploads.push(request.url()); });
  const result = await render(page, fixtures);
  expect(result.error).toBe("");
  if (!("samples" in result) || !result.samples || !("base64" in result) || !result.base64) throw new Error("Render did not return output");
  expect(result).toMatchObject({ width: 1440, height: 2560, fps: 60, frames: 60, duration: 1, verification: "full_decode", verifier: "webcodecs" });
  expect(result.phases).toEqual(expect.arrayContaining(["checking", "rendering", "verifying"]));
  const [first, second, looped, last] = result.samples;
  // Top left switches red -> magenta, then loops back to red.
  expect(first[0][0]).toBeGreaterThan(180); expect(first[0][2]).toBeLessThan(60);
  expect(second[0][0]).toBeGreaterThan(180); expect(second[0][2]).toBeGreaterThan(180);
  expect(looped[0][0]).toBeGreaterThan(180); expect(looped[0][2]).toBeLessThan(60);
  for (const frame of [first, second, looped, last]) {
    expect(frame[1][1]).toBeGreaterThan(75); expect(frame[1][0]).toBeLessThan(70); // green top right
    expect(frame[2][2]).toBeGreaterThan(180); // blue bottom left
    expect(frame[3][0]).toBeGreaterThan(180); expect(frame[3][1]).toBeGreaterThan(180); // yellow bottom right
    expect(Math.max(...frame[4])).toBeLessThan(30); // landscape input gets black padding, no cropping/stretching
  }
  expect(uploads).toEqual([]);
  const output = path.join(directory, `rendered-${testInfo.project.name}.mp4`);
  await writeFile(output, Buffer.from(result.base64, "base64"));
  const info = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]).toString()) as {
    streams: { codec_type: string; codec_name: string; sample_rate?: string; channels?: number; width?: number; height?: number; avg_frame_rate?: string; nb_frames?: string; duration?: string }[];
  };
  const video = info.streams.find(stream => stream.codec_type === "video");
  const audio = info.streams.find(stream => stream.codec_type === "audio");
  expect(video).toMatchObject({ codec_name: "h264", width: 1440, height: 2560, avg_frame_rate: "60/1", nb_frames: "60" });
  expect(audio).toMatchObject({ codec_name: "aac", sample_rate: "44100", channels: 2 });
  expect(Math.abs(Number(video?.duration) - Number(audio?.duration))).toBeLessThanOrEqual(0.05);
  run(ffmpeg, ["-v", "error", "-xerror", "-i", output, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"]);
  const pcm = waveData(run(ffmpeg, ["-v", "error", "-i", output, "-ss", "0.1", "-t", "0.7", "-map", "0:a:0", "-ac", "1", "-ar", "44100", "-c:a", "pcm_f32le", "-f", "wav", "-"]));
  expect(amplitude(pcm, 440)).toBeGreaterThan(0.09);
  expect(amplitude(pcm, 440)).toBeGreaterThan(amplitude(pcm, 1200) * 25);
});

test("rejects short music and corrupted sources without uploading or publishing a partial result", async ({ page }) => {
  const short = await render(page, fixtures, "short");
  expect(short.unexpectedSuccess).toBe(false); expect(short.error).toMatch(/音乐|配乐/);
  const corrupt = await render(page, fixtures, "corrupt");
  expect(corrupt.unexpectedSuccess).toBe(false); expect(corrupt.error).not.toBe("");
});

test("cancels a running render and can render again afterward", async ({ page }) => {
  const cancelled = await render(page, fixtures, "cancel");
  expect(cancelled.unexpectedSuccess).toBe(false); expect(cancelled.error).toMatch(/取消|abort/i);
  const next = await render(page, fixtures);
  expect(next.error).toBe("");
});

test("reports unsupported encoding and exhausted temporary storage without lowering output settings", async ({ page }) => {
  let fault: "encoder" | "storage" = "encoder";
  await page.route(url => url.pathname.endsWith("/render.worker.ts") && url.searchParams.has("worker_file"), async route => {
    const response = await route.fetch();
    const prefix = fault === "encoder"
      ? "Object.defineProperty(globalThis, 'VideoEncoder', { value: undefined });\n"
      : "Object.defineProperty(navigator.storage, 'getDirectory', { value: async () => { throw new DOMException('Test storage quota exceeded', 'QuotaExceededError'); } });\n";
    await route.fulfill({ response, body: prefix + await response.text(), contentType: "text/javascript" });
  });
  const unsupported = await render(page, fixtures);
  expect(unsupported.error).toMatch(/能力|编码|设备/);
  fault = "storage";
  const storage = await render(page, fixtures);
  expect(storage.error).toMatch(/空间|存储|配额/);
});

test("uses the bundled local AAC encoder when the native AAC encoder is absent", async ({ page }) => {
  await page.route(url => url.pathname.endsWith("/render.worker.ts") && url.searchParams.has("worker_file"), async route => {
    const response = await route.fetch();
    await route.fulfill({ response, contentType: "text/javascript", body:
      "Object.defineProperty(globalThis, 'AudioEncoder', { value: undefined });\n" + await response.text() });
  });
  const result = await render(page, fixtures);
  expect(result.error).toBe("");
  expect(result).toMatchObject({ verification: "full_decode", verifier: "webcodecs", frames: 60 });
});

test("temporary-file cleanup protects live results in other tabs and reclaims closed-tab results", async ({ page, context }) => {
  const observer = await context.newPage();
  await openHarness(observer);
  const cleanInactive = () => observer.evaluate(async () => {
    const modulePath = "/lib/edit/client.ts";
    const { cleanupInactiveRenders } = await import(modulePath);
    return cleanupInactiveRenders() as Promise<number>;
  });
  const retained = await render(page, fixtures, "retain");
  expect(retained.error).toBe("");
  if (!("temporaryFile" in retained) || !retained.temporaryFile) throw new Error("No retained render result");
  expect(await cleanInactive()).toBe(0);
  const foreignCleanup = await observer.evaluate(async temporaryFile => {
    const modulePath = "/lib/edit/client.ts";
    const { cleanupRender } = await import(modulePath);
    try { await cleanupRender(temporaryFile); return "unexpected success"; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, retained.temporaryFile);
  expect(foreignCleanup).toMatch(/使用/);
  await page.evaluate(async temporaryFile => {
    const modulePath = "/lib/edit/client.ts";
    const { cleanupRender } = await import(modulePath);
    await cleanupRender(temporaryFile);
  }, retained.temporaryFile);
  expect(await cleanInactive()).toBe(0);
  const abandoned = await render(page, fixtures, "retain");
  expect(abandoned.error).toBe("");
  expect(await cleanInactive()).toBe(0);
  await page.close();
  await expect.poll(cleanInactive).toBe(1);
  expect(await cleanInactive()).toBe(0);
  await observer.close();
});
