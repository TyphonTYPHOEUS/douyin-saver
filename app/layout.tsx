import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拾影 · 抖音视频下载工作台",
  description: "粘贴抖音分享文案，自动识别、批量解析，将喜欢的视频保存到手边。开源、无须登录抖音，记录保存在你的浏览器。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
