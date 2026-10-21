import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = fileURLToPath(new URL("../dist/server/wrangler.json", import.meta.url));
if (!existsSync(config)) throw new Error("请先执行 npm run build。");
const name = process.env.WORKER_NAME || "douyin-saver";
if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new Error("WORKER_NAME 需要使用小写字母、数字和连字符。");
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)), "deploy", "--config", config, "--name", name], { cwd: root, stdio: "inherit" });
process.exitCode = result.status ?? 1;
