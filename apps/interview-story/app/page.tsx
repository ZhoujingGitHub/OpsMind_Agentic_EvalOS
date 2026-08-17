import type { Metadata } from "next";
import StoryClient from "./StoryClient";

export const metadata: Metadata = {
  title: "OpsMind 四系统架构图谱",
  description:
    "用架构图和全量表格讲清 Agent+Harness OpsMind、LangGraph OpsMind、Agentic EvalOS 与 Open5GS/UERANSIM 数字孪生实验室。",
  openGraph: {
    title: "OpsMind 四系统架构图谱",
    description: "四方总图、产品架构、AI 架构、完整 MCP/Skill 与 M3–M5 路线图。",
    images: ["/og.png"],
  },
};

export default function Home() {
  return <StoryClient />;
}
