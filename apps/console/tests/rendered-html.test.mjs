import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("服务端渲染M3.1真实产品评测与改进工作台", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>实验概览 · OpsMind EvalOS<\/title>/i);
  assert.match(html, /可追溯的改进证据/);
  assert.match(html, /数据集与 Case/);
  assert.match(html, /AI 调查员/);
  assert.doesNotMatch(html, /codex-preview/);
});

test("数据集和实验路由均可独立打开", async () => {
  const datasets = await (await render("/datasets")).text();
  const experiments = await (await render("/experiments")).text();
  assert.match(datasets, /数据集与 Case/);
  assert.match(datasets, /版本化考题/);
  assert.match(experiments, /实验运行/);
  assert.match(experiments, /冻结 Manifest/);
});

test("轨迹、评分器和AI调查入口拥有独立可打开页面", async () => {
  const [traces, graders, analyses] = await Promise.all([
    render("/traces").then((response) => response.text()),
    render("/graders").then((response) => response.text()),
    render("/analyses").then((response) => response.text()),
  ]);
  assert.match(traces, /<title>轨迹与日志 · OpsMind EvalOS<\/title>/i);
  assert.match(traces, /href="\/traces" class="active"/);
  assert.match(graders, /<title>评分器中心 · OpsMind EvalOS<\/title>/i);
  assert.match(graders, /href="\/graders" class="active"/);
  assert.match(analyses, /<title>AI 调查员 · OpsMind EvalOS<\/title>/i);
  assert.match(analyses, /href="\/analyses" class="active"/);
});

test("评测任务中心拥有独立页面和人工复评入口", async () => {
  const html = await (await render("/run-requests")).text();
  assert.match(html, /<title>评测任务（Evaluation Tasks） · OpsMind EvalOS<\/title>/i);
  assert.match(html, /异步执行/);
  assert.match(html, /href="\/run-requests" class="active"/);
});

test("工作台明确Agent自主性、确定性评分、源码快照和只读AI边界", async () => {
  const [source, css, server] = await Promise.all([
    readFile(new URL("../app/workbench-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../serve.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(source, /Agent 自主求解/);
  assert.match(source, /官方分数只来自确定性 Code Grader/);
  assert.match(source, /已获得部分分数，仍需改进/);
  assert.match(source, /该维度未通过，需要改进/);
  assert.match(source, /工具名与固定顺序不计分/);
  assert.match(source, /冻结源码/);
  assert.match(source, /诊断权，不是评分权/);
  assert.match(source, /Claude Agent SDK · DeepSeek · 只读/);
  assert.match(source, /href="\/traces"/);
  assert.match(source, /href="\/graders"/);
  assert.match(source, /href="\/analyses"/);
  assert.match(source, /className="clickable-row"/);
  assert.match(source, /navigateRowByKeyboard/);
  assert.doesNotMatch(source, /from "next\/link"/);
  assert.match(source, /#trace/);
  assert.match(source, /#grader/);
  assert.match(source, /#analysis/);
  assert.match(source, /中文解释只帮助阅读，不合并、不改写、不推断原始事实/);
  assert.match(source, /按原配置重新评测/);
  assert.match(source, /新建评测/);
  assert.match(source, /双系统公平对比/);
  assert.match(source, /单系统回归（Single-system regression）/);
  assert.match(source, /request_kind: requestKind/);
  assert.match(source, /intent="new"/);
  assert.match(source, /intent="rerun"/);
  assert.match(source, /快速验证/);
  assert.match(source, /不计正式成绩/);
  assert.match(source, /测试替身/);
  assert.match(source, /定向回归/);
  assert.match(source, /容量演练/);
  assert.match(source, /requested_concurrency/);
  assert.match(source, /本次环境种子/);
  assert.match(source, /environment_seeds: selectedEnvironmentSeeds/);
  assert.match(source, /默认只选一个 Seed/);
  assert.match(source, /建议质量（资格信号，暂不计分）/);
  assert.match(source, /EvalOS 只读展示原件，不生成或改写建议/);
  assert.match(source, /仅重新评分/);
  assert.match(source, /原结果与新结果对比/);
  assert.match(source, /平台运行健康（Operations health）/);
  assert.match(source, /数字孪生（Twin）/);
  assert.match(source, /产品安全熔断/);
  assert.match(source, /已给满产品公开最大资源（Open resources）/);
  assert.match(source, /资源上限仅作安全熔断且用量不评分（Safety fuse）/);
  assert.match(source, /这次失败算在谁头上（Failure ownership）/);
  assert.match(source, /考生没有公开的数据明确显示“未提供”，绝不按 0 计算/);
  assert.match(source, /实时调查进展（Live progress）/);
  assert.match(source, /等待独立考场/);
  assert.match(source, /等待结果/);
  assert.match(source, /最近实质进展/);
  assert.match(source, /15分钟是进展检查点，不是死亡线/);
  assert.match(source, /不按日志数量计分/);
  assert.match(source, /人话解释：/);
  assert.match(source, /重新核验并安全释放考场（Reconcile cleanup）/);
  assert.match(source, /原失败 Trial 和原始证据均未被修改/);
  assert.match(source, /本次能下什么结论（Decision report）/);
  assert.match(source, /title="任务执行失败"/);
  assert.match(source, /前序 Trial 失败后任务已收口，本 Trial 未执行/);
  assert.match(source, /未执行（Not run）/);
  assert.match(source, /执行收口率/);
  assert.match(source, /诊断结论 · 不宣布胜负/);
  assert.match(source, /安全停止任务/);
  assert.match(source, /window.confirm/);
  assert.match(source, /compareUsageMetric/);
  assert.match(source, /评测执行层（Harness）/);
  assert.match(source, /80 个 Case 已冻结，480 次 Trial 尚未创建/);
  assert.match(source, /前往数据集选择 Case 并新建评测/);
  assert.match(source, /该实验不符合当前可执行评测合同，不能按原配置重新评测/);
  assert.match(source, /intent === "rerun" \? \(sourceIsAvailable \? sourceExperimentId : ""\)/);
  assert.match(source, /className="trace-toggle"/);
  assert.doesNotMatch(source, /<button className="trace-body"/);
  assert.match(source, /<\/button>\s*\{open && <JsonBlock/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(server, /EVALOS_API_TOKEN/);
  assert.match(server, /拒绝跨站写请求/);
});
