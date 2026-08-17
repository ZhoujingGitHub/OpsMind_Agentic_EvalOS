import type { Metadata } from "next";
import { Workbench } from "./workbench-client";

export const metadata: Metadata = {
  title: "实验概览 · OpsMind EvalOS",
  description: "从数据集、实验、Trial 轨迹、评分、冻结源码到 AI 深度调查的 Agent 评测工作台。",
};

export default function Home() {
  return <Workbench view="dashboard" />;
}
