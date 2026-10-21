import assert from "node:assert/strict";
import { afterEach, test, mock } from "node:test";
import { decodeShareText, extractLinks, normalizeLink } from "../lib/douyin/links.ts";
import { signToken, verifyToken } from "../lib/douyin/tokens.ts";
import { inspectMp4 } from "../lib/douyin/mp4.ts";
import { fetchMedia, isMediaUrl } from "../lib/douyin/media.ts";
import { parseVideo, pollVideo, shapeVideo } from "../lib/douyin/api-client.ts";
import { serializeHistory, restoreHistory } from "../lib/douyin/history.ts";
import { guard, jsonBody } from "../lib/douyin/guard.ts";
import type { Job } from "../lib/douyin/types.ts";

const secret = "test-only-signing-secret-at-least-32-characters";
const config = { apiBase: "https://api.example.com", apiKey: "test-only-key", tokenSecret: secret };
const source = "https://www.douyin.com/video/1234567890123456789";
const content = { platform: "douyin", kind: "video", content_id: "1234567890123456789", description: "A test video", author: { nickname: "Creator" }, media: { video: { url: "https://a.douyinvod.com/video.mp4", width: 1080, height: 1920, watermark: false } } };
afterEach(() => mock.restoreAll());

test("share text decodes Markdown escapes and HTML entities before extracting links", () => {
  assert.equal(decodeShareText("https\\://v.douyin.com/abc/&#x20;&amp;x"), "https://v.douyin.com/abc/ &x");
  assert.deepEqual(extractLinks("复制打开抖音 https\\://v.douyin.com/abc/&#x20;日期 10/21 。"), { links: ["https://v.douyin.com/abc/"], duplicates: 0, overflow: 0 });
});
test("Markdown labels do not cause unrelated displayed URLs to be downloaded", () => {
  assert.deepEqual(extractLinks(`[${source}](https://example.com/)`).links, []);
  assert.deepEqual(extractLinks(`[作品](${source}?foo=bar)` ).links, [source]);
});
test("standard links, modal links and share pages deduplicate by content id", () => {
  const links = extractLinks(`${source}\nhttps://iesdouyin.com/share/video/1234567890123456789/\nhttps://www.douyin.com/?modal_id=1234567890123456789`);
  assert.equal(links.links.length, 1); assert.equal(links.duplicates, 2);
});
test("batch parsing accepts every link up to the explicit limit", () => {
  const result = extractLinks(Array.from({ length: 52 }, (_, i) => `https://www.douyin.com/video/${i + 1}`).join("\n"));
  assert.equal(result.links.length, 50); assert.equal(result.overflow, 2);
});
test("lookalike domains, credentials, ports and non-video pages are rejected", () => {
  for (const url of ["https://douyin.com.evil.test/video/123", "https://user@www.douyin.com/video/123", "https://www.douyin.com:99/video/123", "https://www.douyin.com:bad/video/123", "https://www.douyin.com/user/123", "file:///video/123"]) assert.equal(normalizeLink(url), null);
});
test("signed download tickets reject tampering, wrong purpose and expiration", async () => {
  const token = await signToken({ kind: "media", contentId: "123" }, secret, 1000);
  assert.equal((await verifyToken(token, secret, "media", 2000)).contentId, "123");
  await assert.rejects(verifyToken(token + "x", secret, "media", 2000));
  await assert.rejects(verifyToken(token, secret, "task", 2000));
  await assert.rejects(verifyToken(token, secret, "media", 700_000));
});
test("missing deployment secrets fail explicitly before a parsing request", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", () => { calls++; throw new Error(); });
  await assert.rejects(parseVideo(source, { ...config, tokenSecret: "" }), /签名密钥/);
  assert.equal(calls, 0);
});
test("private, deleted, wrong-id and image-album results cannot produce a download ticket", async () => {
  for (const bad of [{ ...content, is_private: true }, { ...content, is_deleted: true }, { ...content, kind: "image_album" }, { ...content, content_id: "987" }]) await assert.rejects(shapeVideo(bad, source, config));
});
test("stream ranking prefers clean streams, then resolution, then bitrate", async () => {
  const result = await shapeVideo({ ...content, media: {
    video: { url: "https://a.douyinvod.com/wm", width: 2160, height: 3840, watermark: true },
    streams: [
      { url: "https://a.douyinvod.com/low", width: 720, height: 1280, watermark: false, bitrate: 9000 },
      { url: "https://a.douyinvod.com/high", width: 1080, height: 1920, watermark: false, bitrate: 3000 },
    ],
  } }, source, config);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const ticket = await verifyToken(result.video.mediaToken, secret, "media");
  assert.deepEqual(ticket.urls, ["https://a.douyinvod.com/high"]);
});
test("Douyin zjcdn streams produce a valid ticket with CDN backups", async () => {
  const urls = ["https://v5-dy-ov-experiment.zjcdn.com/video.mp4", "https://v3-dy-o.zjcdn.com/video.mp4", "https://www.douyin.com/aweme/v1/play/"];
  const result = await shapeVideo({ ...content, media: { video: { url: urls[0], urls, width: 1080, height: 1920, watermark: false } } }, source, config);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual((await verifyToken(result.video.mediaToken, secret, "media")).urls, urls);
});
test("valid backup URLs survive missing or unsupported primary addresses", async () => {
  for (const primary of [undefined, "https://unsupported.example/video.mp4"]) {
    const result = await shapeVideo({ ...content, media: { video: {
      url: primary, urls: ["https://127.0.0.1/private", "https://v3-dy-o.zjcdn.com/video.mp4", "https://v3-dy-o.zjcdn.com/video.mp4", "http://a.douyinvod.com/video.mp4"],
      width: 1080, height: 1920, watermark: false,
    } } }, source, config);
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.equal(result.video.width, 1080);
    assert.deepEqual((await verifyToken(result.video.mediaToken, secret, "media")).urls, ["https://v3-dy-o.zjcdn.com/video.mp4"]);
  }
});
test("asynchronous polling reads the same task without resubmitting the original parse", async () => {
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(options.redirect, "manual", "edge runtimes do not support redirect:error");
    calls.push(url);
    return Response.json({ success: true, data: calls.length === 1 ? { task_id: "task-123", state: "queued" } : { task_id: "task-123", state: "done", data: content } });
  });
  const started = await parseVideo(source, config);
  assert.equal(started.status, "pending");
  if (started.status !== "pending") return;
  const ticket = await verifyToken(started.taskToken, secret, "task");
  const done = await pollVideo(String(ticket.taskId), String(ticket.source), config);
  assert.equal(done.status, "ready"); assert.equal(calls.length, 2);
  assert.match(calls[1], /\/tasks\/task-123/);
});
test("upstream rate limits are explicit service-wide blocking errors", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ success: false, error: { code: "RATE_LIMITED", retry_after: 60 } }, { status: 429 }));
  await assert.rejects(parseVideo(source, config), error => !!error && typeof error === "object" && "serviceBlocked" in error && error.serviceBlocked === true);
});
test("media proxy never accepts local hosts or deceptive suffixes", () => {
  for (const url of ["http://a.douyinvod.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://169.254.169.254/x", "https://douyinvod.com.evil.test/x", "https://user:pass@a.douyinvod.com/x", "https://zjcdn.com.evil.test/x", "https://notzjcdn.com/x", "https://user:pass@v3-dy-o.zjcdn.com/x"]) assert.equal(isMediaUrl(url), false);
});
test("every redirect is validated before following it", async () => {
  let calls = 0;
  const requestFetch = (async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }); }) as typeof fetch;
  await assert.rejects(fetchMedia("https://a.douyinvod.com/x", requestFetch), /域名/);
  assert.equal(calls, 1);
});

function box(kind: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(kind, 4); return Buffer.concat([header, payload]);
}
function mp4Fixture(): ArrayBuffer {
  const movie = Buffer.alloc(100); movie.writeUInt32BE(1000, 12); movie.writeUInt32BE(9725, 16);
  const track = Buffer.alloc(84); track.writeUInt32BE(1080 * 65536, 76); track.writeUInt32BE(1920 * 65536, 80);
  const handler = Buffer.alloc(24); handler.write("vide", 8);
  const buffer = Buffer.concat([box("ftyp", Buffer.from("isom0000isommp42")), box("moov", Buffer.concat([box("mvhd", movie), box("trak", Buffer.concat([box("tkhd", track), box("mdia", box("hdlr", handler))]))])), box("mdat", Buffer.alloc(64))]);
  return Uint8Array.from(buffer).buffer;
}
test("MP4 inspector reports actual metadata and only container verification", () => {
  assert.deepEqual(inspectMp4(mp4Fixture()), { width: 1080, height: 1920, duration: 9.725, verification: "container" });
});
test("HTML, truncated files, wrong sizes and missing video tracks are not accepted", () => {
  assert.throws(() => inspectMp4(new TextEncoder().encode("<html>login</html>").buffer));
  assert.throws(() => inspectMp4(mp4Fixture().slice(0, -3)));
  assert.throws(() => inspectMp4(mp4Fixture(), 10));
  const missing = mp4Fixture(); const marker = Buffer.from(missing).indexOf("vide"); new Uint8Array(missing)[marker] = 0;
  assert.throws(() => inspectMp4(missing));
});
test("history strips expiring tickets and never automatically resumes tasks after refresh", () => {
  const jobs: Job[] = [{ id: "test", url: source, status: "ready", addedAt: 100, video: { contentId: content.content_id, title: "Example", author: "Creator", mediaToken: "do-not-persist", width: 1, height: 1, bytes: 10, duration: 1, watermark: false } }];
  const serialized = serializeHistory(jobs);
  assert.equal(serialized.includes("do-not-persist"), false);
  assert.equal(restoreHistory(serialized)[0].status, "stale");
  assert.equal(restoreHistory(serialized)[0].video?.mediaToken, "");
  assert.deepEqual(restoreHistory("not json"), []);
  assert.deepEqual(restoreHistory('[{"url":"https://evil.test/"}]'), []);
});
test("cross-origin browser requests and oversized JSON bodies are rejected", async () => {
  assert.throws(() => guard(new Request("https://site.test/api/parse", { headers: { origin: "https://evil.test" } }), "parse"));
  const request = new Request("https://site.test/api/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "x".repeat(25_000) }) });
  await assert.rejects(jsonBody(request), /过长/);
});
