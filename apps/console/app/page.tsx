import type { Metadata } from "next";
import { M1Console } from "./m1-console";

export const metadata: Metadata = {
  title: "M1 Control Console · OpsMind EvalOS",
  description: "实验、Trial、Trace 与不可变 Ledger 的统一可信视图。",
  other: {
    "codex-preview": "development",
  },
};

export default function Home() {
  return <M1Console />;
}
