import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpsMind 四系统架构图谱",
  description: "用架构图与表格讲清两套 OpsMind、Agentic EvalOS 和 5G 数字孪生。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
