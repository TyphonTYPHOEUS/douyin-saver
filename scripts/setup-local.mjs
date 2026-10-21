import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const secretFile = new URL(".dev.vars", root);
if (!existsSync(secretFile)) {
  writeFileSync(secretFile, `MEDIA_TOKEN_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  console.log("已生成本地签名密钥，保存在被 Git 忽略的 .dev.vars 中。");
} else console.log("保留现有 .dev.vars 配置。");
const manifest = new URL(".openai/hosting.json", root);
if (!existsSync(manifest)) throw new Error(`缺少托管配置：${fileURLToPath(manifest)}`);
console.log("运行 npm run dev，然后打开终端显示的本地地址。");
