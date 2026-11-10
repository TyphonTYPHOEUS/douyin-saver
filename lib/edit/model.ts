export const EDIT_HISTORY_KEY = "douyin-saver.edits.v1";
export const EDIT_HISTORY_LIMIT = 200;

/** Treat names as names, never as paths. Keep them portable across devices. */
export function safeName(value: string): string {
  let name = value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\.mp4$/i, "").trim().replace(/^[. ]+|[. ]+$/g, "");
  name = Array.from(name).slice(0, 100).join("");
  if (!name) throw new Error("请填写成片名称。");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

export function uniqueFilename(value: string, used: Iterable<string>): string {
  const name = safeName(value);
  const existing = new Set(Array.from(used, item => item.toLocaleLowerCase()));
  let suffix = 0;
  while (existing.has(`${name}${suffix ? `_${suffix}` : ""}.mp4`.toLocaleLowerCase())) suffix++;
  return `${name}${suffix ? `_${suffix}` : ""}.mp4`;
}

export function distinctContentIds(ids: string[]): boolean {
  return ids.length === 4 && ids.every(id => /^\d{1,32}$/.test(id)) && new Set(ids).size === 4;
}

export function gridTiming(durations: number[]): {
  frames: number; duration: number; width: 1440; height: 2560; fps: 60;
} {
  if (durations.length !== 4 || durations.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error("需要四个具有有效时长的视频。");
  }
  const frames = Math.ceil(Math.max(...durations) * 60 - 0.0001);
  if (!Number.isSafeInteger(frames) || frames < 1) throw new Error("视频时长无效。");
  return { frames, duration: frames / 60, width: 1440, height: 2560, fps: 60 };
}
