import {
  ADTS, FLAC, MP3, MP4, OGG, WAVE,
  AudioSampleSink, AudioSampleSource, BlobSource, CanvasSource, Input,
  Mp4OutputFormat, Output, Quality, StreamTarget, VideoSampleSink,
  canEncodeAudio, canEncodeVideo,
  type AudioSample, type InputVideoTrack,
} from "mediabunny";
import type { RenderInput, RenderProgress, RenderResult } from "./types";
import { gridTiming } from "./model";

const WIDTH = 1440;
const HEIGHT = 2560;
const FPS = 60;
const TEMP_DIRECTORY = "shiying-renders";
const VIDEO_QUALITY = new Quality({ bitrate: 22_000_000 });
const AUDIO_QUALITY = new Quality({ bitrate: 192_000 });
const AVC = "avc1.640034";
const AAC = "mp4a.40.2";
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

type Progress = (progress: RenderProgress) => void;
type VideoIterator = AsyncGenerator<import("mediabunny").VideoSample | null, void, unknown>;

function temporaryPath(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("剪辑任务标识无效，请重新创建批次。");
  return `${TEMP_DIRECTORY}/${id}.mp4`;
}

export async function cleanupRenderFile(path: string): Promise<void> {
  if (!/^shiying-renders\/[a-zA-Z0-9_-]{1,100}\.mp4$/.test(path)) {
    throw new Error("临时文件路径无效。");
  }
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(TEMP_DIRECTORY);
    await directory.removeEntry(path.slice(TEMP_DIRECTORY.length + 1));
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}

function* timestamps(first: number, duration: number, frames: number) {
  for (let frame = 0; frame < frames; frame++) {
    yield first + ((frame / FPS) % duration);
  }
}

async function requireCapabilities() {
  if (typeof OffscreenCanvas === "undefined" || typeof VideoEncoder === "undefined"
      || typeof VideoDecoder === "undefined" || typeof AudioDecoder === "undefined"
      || !navigator.storage?.getDirectory) {
    throw new Error("当前浏览器缺少本地剪辑能力，请使用桌面版 Chrome 或 Edge；原有下载功能仍可使用。");
  }
  if (!await canEncodeVideo("avc", {
    width: WIDTH, height: HEIGHT, frameRate: FPS, quality: VIDEO_QUALITY,
    fullCodecString: AVC, hardwareAcceleration: "no-preference",
  })) {
    throw new Error("当前设备不支持 1440×2560、60 fps 的 H.264 编码，请换用支持的桌面设备。");
  }
  const audioOptions = {
    numberOfChannels: 2, sampleRate: 44_100, quality: AUDIO_QUALITY, fullCodecString: AAC,
  };
  if (!await canEncodeAudio("aac", audioOptions)) {
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
    if (!await canEncodeAudio("aac", audioOptions)) {
      throw new Error("当前浏览器无法生成所需的 AAC 配乐音轨。");
    }
  }
}

async function verify(file: File, frames: number, duration: number, report: Progress) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4] });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video || !audio || await video.getCodec() !== "avc" || await audio.getCodec() !== "aac"
        || await video.getCodedWidth() !== WIDTH || await video.getCodedHeight() !== HEIGHT
        || await audio.getSampleRate() !== 44_100 || await audio.getNumberOfChannels() !== 2) {
      throw new Error("成片尺寸或音视频轨道不符合剪辑设置，未发布文件。");
    }
    let count = 0;
    let videoEnd = 0;
    report({ phase: "verifying", completed: 0, total: frames * 2, message: "正在完整解码检查画面…" });
    for await (const sample of new VideoSampleSink(video).samples()) {
      try {
        if (count >= frames || Math.abs(sample.timestamp - count / FPS) > 0.002) {
          throw new Error("成片画面帧数或时间戳校验失败，未发布文件。");
        }
        count++;
        videoEnd = sample.timestamp + sample.duration;
        if (count % 30 === 0) {
          report({ phase: "verifying", completed: count, total: frames * 2, message: "正在完整解码检查画面…" });
        }
      } finally { sample.close(); }
    }
    if (count !== frames || Math.abs(videoEnd - duration) > 1 / FPS + 0.001) {
      throw new Error("成片画面不完整或时长不符，未发布文件。");
    }
    let audioEnd = 0;
    let audioStart = Infinity;
    let audioSamples = 0;
    let previousTimestamp = -Infinity;
    for await (const sample of new AudioSampleSink(audio).samples()) {
      try {
        if (!Number.isFinite(sample.timestamp) || sample.timestamp < previousTimestamp
            || sample.numberOfFrames <= 0 || sample.sampleRate !== 44_100 || sample.numberOfChannels !== 2) {
          throw new Error("成片音频解码校验失败，未发布文件。");
        }
        previousTimestamp = sample.timestamp;
        audioSamples += sample.numberOfFrames;
        audioStart = Math.min(audioStart, sample.timestamp);
        audioEnd = Math.max(audioEnd, sample.timestamp + sample.duration);
        report({
          phase: "verifying", completed: frames + Math.min(frames, Math.round(audioEnd / duration * frames)),
          total: frames * 2, message: "正在完整解码检查配乐…",
        });
      } finally { sample.close(); }
    }
    if (!audioSamples || audioStart > 0.05 || Math.abs(audioEnd - videoEnd) > 0.05) {
      throw new Error("成片音轨缺失或音画时长不符，未发布文件。");
    }
    report({ phase: "verifying", completed: frames * 2, total: frames * 2, message: "完整浏览器解码检查通过" });
  } finally { input.dispose(); }
}

/** Runs wholly on the visitor's device. Only ordinary local Blob sources are accepted. */
export async function render(input: RenderInput, report: Progress): Promise<RenderResult> {
  const path = temporaryPath(input.id);
  const inputs: Input[] = [];
  const iterators: VideoIterator[] = [];
  let audioIterator: AsyncGenerator<AudioSample, void, unknown> | undefined;
  let pendingAudio: IteratorResult<AudioSample, void> | undefined;
  let output: Output | undefined;
  let writable: FileSystemWritableFileStream | undefined;
  let succeeded = false;
  let createdFile = false;
  try {
    if (input.videos.length !== 4 || new Set(input.videos).size !== 4) {
      throw new Error("四宫格需要四个不同作品，请补齐或重新选择素材。");
    }
    if (input.videos.some(blob => !(blob instanceof Blob) || !blob.size || blob.size > MAX_VIDEO_BYTES)
        || !(input.music instanceof Blob) || !input.music.size) {
      throw new Error("素材为空或超过单个 200 MB 的限制，请检查视频与音乐文件。");
    }
    report({ phase: "checking", completed: 0, total: 5, message: "正在检查本机剪辑能力…" });
    await requireCapabilities();
    const videos: { track: InputVideoTrack; first: number; duration: number }[] = [];
    for (const [index, blob] of input.videos.entries()) {
      const media = new Input({ source: new BlobSource(blob), formats: [MP4] });
      inputs.push(media);
      const track = await media.getPrimaryVideoTrack();
      if (!track || !await track.canDecode()) throw new Error(`第 ${index + 1} 个视频无法在当前设备解码。`);
      const first = Math.max(0, await track.getFirstTimestamp());
      const duration = await track.computeDuration() - first;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`第 ${index + 1} 个视频没有有效时长。`);
      videos.push({ track, first, duration });
      report({ phase: "checking", completed: index + 1, total: 5, message: `已检查 ${index + 1} 个视频` });
    }
    const { frames, duration } = gridTiming(videos.map(video => video.duration));
    const music = new Input({ source: new BlobSource(input.music), formats: [MP3, WAVE, MP4, ADTS, FLAC, OGG] });
    inputs.push(music);
    const musicTrack = await music.getPrimaryAudioTrack();
    if (!musicTrack || !await musicTrack.canDecode()) throw new Error("所选音乐没有可解码音轨，请更换音乐。");
    const musicStart = Math.max(0, await musicTrack.getFirstTimestamp());
    const musicDuration = await musicTrack.computeDuration() - musicStart;
    if (!Number.isFinite(musicDuration) || musicDuration + 0.025 < duration) {
      throw new Error(`配乐比成片短 ${Math.max(0, duration - (musicDuration || 0)).toFixed(2)} 秒，请更换足够长的音乐；不会自动循环歌曲。`);
    }
    report({ phase: "checking", completed: 5, total: 5, message: "素材与配乐检查通过" });

    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(TEMP_DIRECTORY, { create: true });
    const filename = path.slice(TEMP_DIRECTORY.length + 1);
    // Operation IDs are fresh UUIDs generated by the client. Refuse an existing result.
    try {
      await directory.getFileHandle(filename);
      throw new Error("此剪辑任务已有临时结果，请重新开始。");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
    const handle = await directory.getFileHandle(filename, { create: true });
    createdFile = true;
    writable = await handle.createWritable();
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const context = canvas.getContext("2d", { alpha: false });
    const panel = new OffscreenCanvas(WIDTH / 2, HEIGHT / 2);
    const panelContext = panel.getContext("2d", { alpha: false });
    if (!context || !panelContext) {
      await writable.close();
      throw new Error("当前设备无法创建剪辑画布。");
    }
    const videoSource = new CanvasSource(canvas, {
      codec: "avc", fullCodecString: AVC, quality: VIDEO_QUALITY,
      hardwareAcceleration: "no-preference", keyFrameInterval: 2,
    });
    const audioSource = new AudioSampleSource({
      codec: "aac", fullCodecString: AAC, quality: AUDIO_QUALITY,
      transform: { numberOfChannels: 2, sampleRate: 44_100 },
    });
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: "reserve" }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 2 ** 20 }),
    });
    output.addVideoTrack(videoSource, { frameRate: FPS, maximumPacketCount: frames });
    output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(1.5 * duration * 44_100 / 1024) + 64 });
    for (const video of videos) {
      iterators.push(new VideoSampleSink(video.track).samplesAtTimestamps(timestamps(video.first, video.duration, frames)));
    }
    audioIterator = new AudioSampleSink(musicTrack).samples(musicStart, musicStart + duration);
    pendingAudio = await audioIterator.next();
    await output.start();

    const addAudioUntil = async (until: number) => {
      while (pendingAudio && !pendingAudio.done && pendingAudio.value.timestamp - musicStart < until) {
        const sample = pendingAudio.value;
        pendingAudio = undefined;
        let trimmed: AudioSample | undefined;
        try {
          const start = Math.max(0, Math.min(sample.numberOfFrames, Math.ceil((musicStart - sample.timestamp) * sample.sampleRate - 0.0001)));
          const end = Math.max(start, Math.min(sample.numberOfFrames, Math.floor((musicStart + duration - sample.timestamp) * sample.sampleRate + 0.0001)));
          if (end > start) {
            trimmed = sample.trim(start, end);
            trimmed.setTimestamp(Math.max(0, trimmed.timestamp - musicStart));
            await audioSource.add(trimmed);
          }
        } finally { trimmed?.close(); sample.close(); }
        pendingAudio = await audioIterator!.next();
      }
    };

    report({ phase: "rendering", completed: 0, total: frames, message: "正在本机合成四宫格…" });
    for (let frame = 0; frame < frames; frame++) {
      context.fillStyle = "black";
      context.fillRect(0, 0, WIDTH, HEIGHT);
      for (const [index, iterator] of iterators.entries()) {
        const next = await iterator.next();
        if (next.done || !next.value) throw new Error(`第 ${index + 1} 个视频在合成时缺少画面。`);
        try {
          panelContext.fillStyle = "black";
          panelContext.fillRect(0, 0, WIDTH / 2, HEIGHT / 2);
          next.value.drawWithFit(panelContext, { fit: "contain" });
          context.drawImage(panel, index % 2 * WIDTH / 2, Math.floor(index / 2) * HEIGHT / 2);
        } finally { next.value.close(); }
      }
      await videoSource.add(frame / FPS, 1 / FPS);
      if ((frame + 1) % FPS === 0 || frame === frames - 1) await addAudioUntil((frame + 1) / FPS);
      if ((frame + 1) % 15 === 0 || frame === frames - 1) {
        report({ phase: "rendering", completed: frame + 1, total: frames, message: "正在本机合成四宫格…" });
      }
    }
    await addAudioUntil(duration);
    videoSource.close();
    audioSource.close();
    await output.finalize();
    const file = await handle.getFile();
    if (!file.size) throw new Error("成片文件为空，未发布文件。");
    await verify(file, frames, duration, report);
    succeeded = true;
    return {
      file, temporaryFile: path, width: WIDTH, height: HEIGHT, fps: FPS,
      frames, duration, bytes: file.size, verification: "full_decode", verifier: "webcodecs",
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new Error("浏览器临时存储空间不足，剪辑已停止；请清理成片记录或释放磁盘空间后重试。");
    }
    throw error;
  } finally {
    pendingAudio?.value?.close();
    await Promise.allSettled(iterators.map(iterator => iterator.return()));
    if (audioIterator) await audioIterator.return().catch(() => {});
    if (output && output.state !== "finalized" && output.state !== "canceled") {
      await output.cancel().catch(() => {});
    }
    // If setup failed before StreamTarget acquired its writer, release the file here.
    if (writable && !writable.locked) await writable.close().catch(() => {});
    for (const media of inputs) media.dispose();
    if (!succeeded && createdFile) await cleanupRenderFile(path).catch(() => {});
  }
}
