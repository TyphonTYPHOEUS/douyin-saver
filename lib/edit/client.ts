/// <reference types="vite/client" />
import RenderWorker from "./render.worker?worker";
import type { RenderInput, RenderProgress, RenderResult } from "./types";

type Reply = { type: "progress"; progress: RenderProgress }
  | { type: "complete"; result: RenderResult }
  | { type: "error"; message: string };

const TEMP_PATH = /^shiying-renders\/([a-zA-Z0-9_-]{1,100})\.mp4$/;
type HeldLock = { release: () => void; finished: Promise<void> };
// The main page, rather than the short-lived render Worker, owns a completed result's lock.
const ownedResults = new Map<string, HeldLock>();

function lockName(temporaryFile: string): string {
  const match = TEMP_PATH.exec(temporaryFile);
  if (!match) throw new Error("临时文件路径无效。");
  return `shiying-render:${match[1]}`;
}

function requireLocks(): LockManager {
  if (!navigator.locks?.request) {
    throw new Error("当前浏览器缺少安全管理本地成片的能力，请使用桌面版 Chrome 或 Edge。");
  }
  return navigator.locks;
}

async function holdResult(temporaryFile: string): Promise<void> {
  const locks = requireLocks();
  let release!: () => void;
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  let granted!: () => void;
  let denied!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { granted = resolve; denied = reject; });
  const finished = locks.request(lockName(temporaryFile), { ifAvailable: true }, async lock => {
    if (!lock) throw new Error("此临时成片仍在使用，请重新创建剪辑任务。");
    granted();
    await lifetime;
  }).then(() => {});
  ownedResults.set(temporaryFile, { release, finished });
  void finished.catch(denied);
  try { await ready; }
  catch (error) { ownedResults.delete(temporaryFile); throw error; }
}

async function removeTemporaryFile(temporaryFile: string): Promise<boolean> {
  lockName(temporaryFile);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("shiying-renders");
      await dir.removeEntry(temporaryFile.slice("shiying-renders/".length));
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return false;
      // Worker termination can briefly leave its file lock in the process of being released.
      if (attempt < 2 && error instanceof DOMException
          && ["NoModificationAllowedError", "InvalidModificationError", "InvalidStateError"].includes(error.name)) {
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  return false;
}

/** Deletes a known result under its ownership lock; never touches device downloads. */
export async function cleanupRender(temporaryFile: string): Promise<void> {
  const name = lockName(temporaryFile);
  const owned = ownedResults.get(temporaryFile);
  if (owned) {
    try { await removeTemporaryFile(temporaryFile); }
    finally {
      owned.release();
      await owned.finished.catch(() => {});
      if (ownedResults.get(temporaryFile) === owned) ownedResults.delete(temporaryFile);
    }
    return;
  }
  await requireLocks().request(name, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error("此成片仍在另一个页面中使用，暂时无法清理。");
    await removeTemporaryFile(temporaryFile);
  });
}

/** Reclaims files abandoned by refresh/closed tabs, skipping all live renders and previews. */
export async function cleanupInactiveRenders(): Promise<number> {
  const locks = requireLocks();
  if (!navigator.storage?.getDirectory) throw new Error("当前浏览器不支持本地临时文件管理。");
  let directory: FileSystemDirectoryHandle;
  try {
    const root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle("shiying-renders");
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return 0;
    throw error;
  }
  let removed = 0;
  // TypeScript's DOM declarations omit the async-iterable directory methods in this build.
  const iterable = directory as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  };
  for await (const [filename, handle] of iterable.entries()) {
    const path = `shiying-renders/${filename}`;
    if (handle.kind !== "file" || !TEMP_PATH.test(path)) continue;
    await locks.request(lockName(path), { ifAvailable: true }, async lock => {
      if (lock && await removeTemporaryFile(path)) removed++;
    });
  }
  return removed;
}

/** A dedicated Worker keeps encoding, decoding and MP4 work off the interface thread. */
export async function renderBatch(
  input: RenderInput,
  onProgress: (progress: RenderProgress) => void,
  signal?: AbortSignal,
): Promise<RenderResult> {
  if (signal?.aborted) throw new DOMException("剪辑已取消", "AbortError");
  if (typeof Worker === "undefined") throw new Error("当前浏览器不支持本地剪辑，请使用桌面版 Chrome 或 Edge。");
  const operationId = crypto.randomUUID();
  const temporaryFile = `shiying-renders/${operationId}.mp4`;
  await holdResult(temporaryFile);
  if (signal?.aborted) {
    await cleanupRender(temporaryFile);
    throw new DOMException("剪辑已取消", "AbortError");
  }
  // Let Vite emit the worker URL before the RSC transform rewrites import.meta.url.
  let worker: Worker;
  try { worker = new RenderWorker(); }
  catch (error) { await cleanupRender(temporaryFile); throw error; }
  return new Promise<RenderResult>((resolve, reject) => {
    let settled = false;
    const dispose = () => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      dispose();
      // Termination releases the OPFS write handle. Cleanup failure must not hide the original error.
      void cleanupRender(temporaryFile).catch(() => {}).finally(() => reject(error));
    };
    const abort = () => fail(new DOMException("剪辑已取消", "AbortError"));
    worker.onmessage = (event: MessageEvent<Reply>) => {
      if (settled) return;
      if (event.data.type === "progress") {
        onProgress(event.data.progress);
      } else if (event.data.type === "complete") {
        settled = true;
        dispose();
        resolve(event.data.result);
      } else {
        fail(new Error(event.data.message));
      }
    };
    worker.onerror = event => {
      event.preventDefault();
      fail(new Error(event.message || "剪辑进程意外中断，请检查设备能力后重试。"));
    };
    worker.onmessageerror = () => fail(new Error("浏览器无法接收剪辑结果，请重试。"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage({ type: "render", input: { ...input, id: operationId } }); }
    catch (error) { fail(error instanceof Error ? error : new Error("无法启动剪辑任务。")); }
  });
}
