import { cleanupRenderFile, render } from "./engine";
import type { RenderInput } from "./types";

type Request = { type: "render"; input: RenderInput } | { type: "cleanup"; temporaryFile: string };
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};
let active = false;

scope.onmessage = event => {
  void (async () => {
    try {
      if (event.data.type === "cleanup") {
        await cleanupRenderFile(event.data.temporaryFile);
        return;
      }
      if (active) throw new Error("已有剪辑任务正在进行，请稍后重试。");
      active = true;
      const result = await render(event.data.input, progress => scope.postMessage({ type: "progress", progress }));
      scope.postMessage({ type: "complete", result });
    } catch (error) {
      scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "本地剪辑失败，请检查素材后重试。" });
    } finally { active = false; }
  })();
};
