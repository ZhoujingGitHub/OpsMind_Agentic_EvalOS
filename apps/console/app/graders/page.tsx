import type { Metadata } from "next";
import { Workbench } from "../workbench-client";

export const metadata: Metadata = {
  title: "评分器中心 · OpsMind EvalOS",
  description: "查看确定性 Code Grader 的正式成绩、评分细项和不可补偿硬门禁。",
};

export default function GradersPage() {
  return <Workbench view="graders" />;
}
