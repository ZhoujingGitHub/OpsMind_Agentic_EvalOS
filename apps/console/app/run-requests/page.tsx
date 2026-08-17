import type { Metadata } from "next";
import { Workbench } from "../workbench-client";
export const metadata: Metadata = { title: "评测任务（Evaluation Tasks） · OpsMind EvalOS",
  description: "人工选择 Case，执行前检查，异步重新评测并比较新旧证据，不覆盖原始 Trial。" };
export default function EvaluationTasksPage() { return <Workbench view="run-requests" />; }
