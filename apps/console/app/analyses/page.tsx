import type { Metadata } from "next";
import { Workbench } from "../workbench-client";

export const metadata: Metadata = {
  title: "AI 调查员 · OpsMind EvalOS",
  description: "查看只读 AI 调查运行、调查轨迹、诊断报告、冻结源码引用和权威方法论来源。",
};

export default function AnalysesPage() {
  return <Workbench view="analyses" />;
}
