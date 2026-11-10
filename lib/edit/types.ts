export type RenderInput = {
  id: string;
  name: string;
  videos: Blob[];
  music: File;
};

export type RenderProgress = {
  phase: "checking" | "rendering" | "verifying";
  completed: number;
  total: number;
  message: string;
};

export type RenderResult = {
  file: File;
  temporaryFile: string;
  width: 1440;
  height: 2560;
  fps: 60;
  frames: number;
  duration: number;
  bytes: number;
  verification: "full_decode";
  verifier: "webcodecs";
};

export type RenderRequest =
  | { type: "render"; input: RenderInput }
  | { type: "cleanup"; temporaryFile: string };

export type RenderReply =
  | { type: "progress"; progress: RenderProgress }
  | { type: "complete"; result: RenderResult }
  | { type: "error"; message: string };
