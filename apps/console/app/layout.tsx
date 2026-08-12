import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpsMind EvalOS · M1 Control Console",
  description: "可信、可复现、可解释的 Agent 评测控制台。",
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
