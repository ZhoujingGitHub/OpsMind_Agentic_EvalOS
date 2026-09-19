#!/usr/bin/env node
// 只读探针：交叉比对 20 个 M2 基础场景的 required_evidence，
// 找出「只出现在一个场景里」的判别性事实。不改任何文件、不连服务器。
import { M2_CASES } from "../../../packages/kernel/src/m2-cases.mjs";

const scenarios = Object.values(M2_CASES);
const owners = new Map();
for (const item of scenarios) {
  for (const ref of item.ground_truth.required_evidence) {
    if (!owners.has(ref)) owners.set(ref, []);
    owners.get(ref).push(item.id);
  }
}

console.log("=== 事实 → 出现在哪些场景（按出现次数排序）===");
[...owners.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  .forEach(([ref, ids]) => {
    console.log(`  ${ids.length === 1 ? "判别性" : "共享  "} | ${ref.padEnd(42)} | ${ids.join(",")}`);
  });

console.log("\n=== 每个场景的判别性事实（只出现在它自己身上的）===");
let missing = 0;
for (const item of scenarios) {
  const discriminative = item.ground_truth.required_evidence.filter((ref) => owners.get(ref).length === 1);
  if (!discriminative.length) missing += 1;
  console.log(`  ${item.id.padEnd(20)} ${item.environment.scenario_id.padEnd(24)} ${
    discriminative.length ? discriminative.join(" + ") : "**没有唯一事实**"}`);
}
console.log(`\n>>> 没有判别性事实的场景数: ${missing}/${scenarios.length}`);

console.log("\n=== 活实验室能真正发出来的事实形态（三类）===");
console.log("  process:<resource_id>-healthy        service_health 诊断");
console.log("  pcap:<protocol>-observed             packet_capture 摘要");
console.log("  policy:<proto>:<port>:drop-rule-present   network_policy 只读诊断");
console.log("\n=== 静态 required 里哪些事实活实验室根本发不出来 ===");
const liveShapes = [/^process:[a-z0-9_.-]+-healthy$/, /^pcap:[a-z][a-z0-9_]*-observed$/,
  /^policy:(sctp|udp|tcp):[0-9]{1,5}:drop-rule-present$/];
const unreachable = [...owners.keys()].filter((ref) => !liveShapes.some((shape) => shape.test(ref)));
console.log(`  共 ${unreachable.length}/${owners.size} 条只存在于静态题面：`);
unreachable.sort().forEach((ref) => console.log(`    ${ref}`));
