import { MAX_VIDEO_BYTES } from "./media.ts";

type Box = { type: string; start: number; end: number };
function boxes(data: DataView, start: number, end: number): Box[] {
  const result: Box[] = [];
  for (let offset = start; offset < end;) {
    if (end - offset < 8) throw new Error("视频文件尾部不完整。");
    let size = data.getUint32(offset);
    let header = 8;
    const type = String.fromCharCode(...new Uint8Array(data.buffer, data.byteOffset + offset + 4, 4));
    if (size === 1) {
      if (end - offset < 16) throw new Error("视频数据块不完整。");
      const large = data.getBigUint64(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("视频数据块过大。");
      size = Number(large); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) throw new Error("视频文件已截断，未发起保存。");
    result.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

export function inspectMp4(buffer: ArrayBuffer, expectedSize?: number): { width: number; height: number; duration: number; verification: "container" } {
  if (buffer.byteLength > MAX_VIDEO_BYTES) throw new Error("当前版本支持 200 MB 以内的视频。");
  if (expectedSize && buffer.byteLength !== expectedSize) throw new Error("文件大小与解析结果不一致，未发起保存。");
  const data = new DataView(buffer);
  const top = boxes(data, 0, buffer.byteLength);
  if (!["ftyp", "moov", "mdat"].every(type => top.some(box => box.type === type && box.end > box.start))) throw new Error("返回的文件不是完整的 MP4 视频。");
  const movie = top.find(box => box.type === "moov")!;
  let duration = 0, width = 0, height = 0;
  for (const box of boxes(data, movie.start, movie.end)) {
    if (box.type === "mvhd") {
      const version = data.getUint8(box.start);
      if (version === 0 && box.end - box.start >= 20) {
        duration = data.getUint32(box.start + 16) / data.getUint32(box.start + 12);
      } else if (version === 1 && box.end - box.start >= 32) {
        duration = Number(data.getBigUint64(box.start + 24)) / data.getUint32(box.start + 20);
      }
    }
    if (box.type !== "trak") continue;
    const track = boxes(data, box.start, box.end);
    const header = track.find(item => item.type === "tkhd");
    const media = track.find(item => item.type === "mdia");
    if (!header || header.end - header.start < 84 || !media) continue;
    const handler = boxes(data, media.start, media.end).find(item => item.type === "hdlr");
    if (!handler || handler.end - handler.start < 12) continue;
    const type = String.fromCharCode(...new Uint8Array(buffer, handler.start + 8, 4));
    if (type !== "vide") continue;
    const w = data.getUint32(header.end - 8) >>> 16, h = data.getUint32(header.end - 4) >>> 16;
    if (w * h > width * height) { width = w; height = h; }
  }
  if (!Number.isFinite(duration) || duration <= 0 || !width || !height) throw new Error("视频缺少有效的时长或画面轨道。");
  return { width, height, duration, verification: "container" };
}
