import type { Metadata } from "next";
import { Workbench } from "../workbench-client";

export const metadata: Metadata = {
  title: "轨迹与日志 · OpsMind EvalOS",
  description: "查看所有正式 Trial 的完整只追加轨迹，并进入单 Trial 日志研究页。",
};

export default function TracesPage() {
  return <Workbench view="traces" />;
}
