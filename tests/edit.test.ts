import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { distinctContentIds, gridTiming, safeName, uniqueFilename } from "../lib/edit/model.ts";
import { clearReceived, MediaRequestError, peekReceived, pinReceived, receiveVideo, setMediaServiceBlocked, setTransfersPaused } from "../lib/douyin/receive.ts";
import type { ParsedVideo } from "../lib/douyin/types.ts";

afterEach(() => { mock.restoreAll(); setMediaServiceBlocked(null); setTransfersPaused(false); pinReceived([]); clearReceived(); });

test("four-grid requires distinct resolved works, including short-link aliases", () => {
  assert.equal(distinctContentIds(["1", "2", "3", "4"]), true);
  for (const ids of [["1", "2", "3"], ["1", "2", "3", "4", "5"], ["1", "2", "3", "1"], ["1", "2", "3", ""]]) {
    assert.equal(distinctContentIds(ids), false);
  }
});

test("longest video determines frame-aligned duration, without truncating its last frame", () => {
  const result = gridTiming([0.5, 1.001, 0.8, 1]);
  assert.equal(result.frames, 61);
  assert.equal(result.duration, 61 / 60);
  assert.deepEqual(gridTiming([1, 1, 1, 1]), { frames: 60, duration: 1, width: 1440, height: 2560, fps: 60 });
  for (const durations of [[1, 2, 3], [1, 2, 3, NaN], [1, 0, 1, 1], [1, Infinity, 1, 1]]) assert.throws(() => gridTiming(durations));
});

test("names cannot escape directories and result names do not overwrite same-session outputs", () => {
  assert.equal(safeName("../四格\\音乐:作品.mp4"), "_四格_音乐_作品");
  assert.equal(safeName("CON"), "_CON");
  assert.throws(() => safeName(" ... "));
  assert.equal(uniqueFilename("作品.MP4", ["作品.mp4", "作品_1.mp4"]), "作品_2.mp4");
  assert.equal(uniqueFilename("Sample", ["sample.mp4"]), "Sample_1.mp4");
});

function box(type: string, content: Buffer) {
  const header = Buffer.alloc(8); header.writeUInt32BE(content.length + 8); header.write(type, 4);
  return Buffer.concat([header, content]);
}
function fixture(): Uint8Array<ArrayBuffer> {
  const movie = Buffer.alloc(100); movie.writeUInt32BE(1000, 12); movie.writeUInt32BE(1000, 16);
  const track = Buffer.alloc(84); track.writeUInt32BE(720 * 65536, 76); track.writeUInt32BE(1280 * 65536, 80);
  const handler = Buffer.alloc(24); handler.write("vide", 8);
  return Uint8Array.from(Buffer.concat([
    box("ftyp", Buffer.from("isom0000isommp42")),
    box("moov", Buffer.concat([box("mvhd", movie), box("trak", Buffer.concat([box("tkhd", track), box("mdia", box("hdlr", handler))]))])),
    box("mdat", Buffer.alloc(64)),
  ]));
}
const video = (id: string): ParsedVideo => ({ contentId: id, title: "test", author: "test", width: 720, height: 1280, duration: 1, bytes: fixture().byteLength, watermark: null, mediaToken: "test-ticket" });
const response = () => new Response(fixture(), { headers: { "content-length": String(fixture().byteLength) } });
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test("download and editor share the same pending transfer and checked Blob", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  const [a, b] = await Promise.all([receiveVideo(video("101")), receiveVideo(video("101"))]);
  assert.equal(calls, 1); assert.equal(a, b); assert.equal(peekReceived("101"), a);
  await receiveVideo({ ...video("101"), mediaToken: "" });
  assert.equal(calls, 1, "valid session cache does not need a fresh signed ticket");
});

test("shared receiving queue never opens more than two media transfers", async () => {
  const release: Array<(value: Response) => void> = [];
  let active = 0, maxActive = 0;
  mock.method(globalThis, "fetch", () => {
    active++; maxActive = Math.max(active, maxActive);
    return new Promise<Response>(resolve => release.push(value => { active--; resolve(value); }));
  });
  const requests = ["201", "202", "203"].map(id => receiveVideo(video(id)));
  await turn(); assert.equal(release.length, 2);
  release[0](response()); await turn(); assert.equal(release.length, 3);
  release[1](response()); release[2](response());
  await Promise.all(requests); assert.equal(maxActive, 2);
});

test("rendering pauses new transfers and unpausing drains the queue", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  setTransfersPaused(true);
  const pending = receiveVideo(video("301"));
  await turn(); assert.equal(calls, 0);
  setTransfersPaused(false); await pending; assert.equal(calls, 1);
});

test("media rate limits retain blocking details and failed cache entries can retry", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => ++calls === 1
    ? Response.json({ error: "服务限流", code: "RATE_LIMITED", serviceBlocked: true }, { status: 429 }) : response());
  await assert.rejects(receiveVideo(video("401")), error => error instanceof MediaRequestError && error.detail.serviceBlocked);
  assert.equal(peekReceived("401"), undefined);
  setMediaServiceBlocked(null);
  await receiveVideo(video("401")); assert.equal(calls, 2);
});

test("expired tickets and truncated files are rejected without caching broken media", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => { calls++; return new Response(fixture().slice(0, -1)); });
  await assert.rejects(receiveVideo({ ...video("501"), mediaToken: "" }), /失效/);
  assert.equal(calls, 0);
  await assert.rejects(receiveVideo(video("502")), /大小|截断|不完整/);
  assert.equal(peekReceived("502"), undefined);
});

test("a blocked media service rejects queued and new work without issuing more requests", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  setTransfersPaused(true);
  const first = receiveVideo(video("701"));
  const rejected = assert.rejects(first, error => error instanceof MediaRequestError && error.detail.serviceBlocked);
  await turn(); setMediaServiceBlocked("服务限流"); await rejected;
  await assert.rejects(receiveVideo(video("702")), error => error instanceof MediaRequestError && error.detail.serviceBlocked);
  assert.equal(calls, 0);
  setMediaServiceBlocked(null); setTransfersPaused(false);
  await receiveVideo(video("701")); assert.equal(calls, 1);
});

test("cache clearing preserves sources pinned by an active editing batch", async () => {
  mock.method(globalThis, "fetch", async () => response());
  await Promise.all([receiveVideo(video("601")), receiveVideo(video("602"))]);
  pinReceived(["601"]); clearReceived();
  assert.ok(peekReceived("601")); assert.equal(peekReceived("602"), undefined);
});
