import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "127.0.0.1:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  const title = "OpsMind Agentic EvalOS · 评测与改进工作台";
  const description = "真实实验、完整轨迹、确定性评分、冻结源码与只读 AI 深度调查。";
  return { title, description, icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title, description, type: "website", locale: "zh_CN", images: [{ url: image, width: 1200, height: 630,
      alt: "OpsMind Agentic EvalOS：把每次评测，变成可追溯的改进证据" }] },
    twitter: { card: "summary_large_image", title, description, images: [image] } };
}

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
