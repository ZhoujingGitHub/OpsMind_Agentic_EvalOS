# HANDOFF：四条链路收口、测试基建清债、控制台对外开放

固化日期：2026-09-16
上一份：`docs/HANDOFF_四条链路修复实施_ClaudeCode_20260914.md`
本轮结论：**四条链路 + 对照实验全部通过并收口；测试基建四条债全清；EvalOS 控制台已可从任意网络登录。**

---

## 1. 线上身份（= main = 生产标签，三项已逐一核对）

| 组件 | 线上提交 | 发布件 | 生产标签 |
|---|---|---|---|
| Agent+Harness | `7b1123a8a591b77be2ba553a5cf3c863c24beafa` | `opsmind-agent-harness:7b1123a8a591`<br>镜像 `sha256:c9110f032eaf9a03255a543e0945fc0323fb1c9029d2a31ea795d3223e279c85` | `prod-agent-harness-20260915-test-isolation` |
| LangGraph | `697a826a7ace116836a5a1b02623647f8af54f4a` | `opsmind-langgraph-v1:697a826a7ace`<br>镜像 `sha256:2feb34ed707bd36fa1216fd8a30b36b2436181a42fcb05a4e81138b56464c55a` | `prod-langgraph-20260914-business-truth-contract` |
| EvalOS | `1a6eefc30c20475d61ed48dce0e361d9bcdf5180` | `m31-20260915-3c8bbde76c` | `prod-evalos-20260915-test-isolation` |
| 5G 实验室控制器 | `18d3eb90dc5038d66071bb7fc734d901830ef41a` | `twin-controller-20260914-20230668db` | `prod-twin-20260914-business-truth-contract` |

三个仓库 `main` 与 `origin/main` 一致；每个组件都核对过「线上提交是 main 祖先 = origin/main 祖先 = 标签目标」。

冻结源实验（本轮最终）：`exp_d3e867ec11bc04410b25`
公开症状四条链路逐字节一致：`goal_sha256 = fb0dbd53eb285b26e287b8349906fe4586473520ece5e84b35407f0c38965352`

---

## 2. 验收结果

| 链路 | 标识 | 结果 | 基线 |
|---|---|---|---|
| ① AH→5G | `inv-75d347b34b3b` | 通过，`conclusion_status: confirmed` | — |
| ② LG→5G | `inv-3e577111c1be4798ad53fa0f` | `root_cause_confirmed` 0.95，独立业务复测通过 | 此前零动作零验证 |
| ③ AH→EvalOS→5G | `trial_787ed2b2df7402e7d367` | **96.43**，15/15 硬门 | 92.14 |
| ④ LG→EvalOS→5G | `trial_8be82e5264cb6a2fbc5d` | **100**，15/15 硬门 | **39.29** |
| ⑤ 对照（故意不修数据面，EvalOS） | `trial_d7bdff026c116e4fd8cc` | **`environment_recovery: false`**，64.29 判负 | — |
| ⑤-b 强对照（直连） | `inv-37e9847fe582` | 控制面修好、数据面仍断 → `business_passed: **false**` | — |

③ 的 96.43 是 `evidence_quality` 命中 5/6，属模型逐次波动，非回归。
⑤ 与 ⑤-b 合起来证明：控制面修好 + 进程存活 ≠ 业务恢复；业务真值非 `passed` 时 `environment_recovery` 必须 false（`inconclusive` 也算不通过）。

**控制台点击端到端验收**：`console-click-e2e-20260916/`，**10/10 通过**。逐个点击 6 个导航项并核对标题，点进冻结源实验，打开 ③④ 的 Trial 详情页，页面上确实渲染出 96.4 与 100。含 10 张截图 + SHA256SUMS。

---

## 3. 证据位置

统一目录：`/srv/opsmind-evidence/business-truth-contract-20260914/`

- **产品机**（`114.55.40.170`）：链路 ①②⑤-b 的调查全量 JSON + .gz
- **EvalOS 机**（`121.40.223.202`）：链路 ③④⑤ 的 Trial 全量 JSON + .gz，
  `console-click-e2e-20260916/`（点击验收报告 + 截图），
  `deployment-proof-20260915.json`、`candidate-discovery-20260915.json`
- **D 盘**：`_work/claude-takeover-20260911/验收证据清单_业务真值契约_20260914.md`（含各份 sha256，防云盘丢失）

---

## 4. 控制台访问方式（本轮新增）

```
https://121-40-223-202.sslip.io/     ← 必须 https
账号 opsmind
口令 见本轮会话记录 / 服务器 /etc/nginx/opsmind-console.htpasswd（口令不入 Git）
```

- 原先的 `allow 111.55.79.0/24; deny all;` **已整条移除**，改为 nginx Basic 认证 + `limit_req` 限速。
  换 WiFi / 换 VPN / 换设备 / 给别人用都不受影响。
- `location ^~ /api/candidate-relay/`、`location = /api/candidate-presence`、
  `location ~ ^/api/trials/.../judge` 三个机器对机器入口**未加认证**（有自己的令牌），改动时不要碰。
- 开关：`/etc/nginx/opsmind-console-access.conf` 为空=开放，写入 `deny all;` 则关闭；改后 `nginx -t && systemctl reload nginx`。
- 改动前配置备份：`/etc/nginx/opsmind-evalos.backup-20260915-before-auth`

**为什么必须 https**：`sslip.io` 未备案，大陆公网走 80 端口会被阿里云替换成"域名暂时无法访问"页，根本到不了服务器。云内互访不受影响。

---

## 5. 账单（本轮出过两次事故，务必盯住）

| 账号 | UID | 管什么 | 到期 |
|---|---|---|---|
| 主账号 | `1275476353815639` | 产品机 + 5G 实验室 | 2026-11-10 |
| evallab | `1832716768005950` | EvalOS | 2026-11-15 |

2026-09-15 当天因欠费出了两次事：

1. 余额 -1.05 → EvalOS 实例被**停机并锁定**（`OperationLocks: financial`）
2. 余额 -0.59 → 实例活着但**公网被限**，TCP 能连、TLS 握手包出不去，relay 断了 2 小时

**机器是包月、流量是后付费**——买了包月不等于不会欠费。9 月账单里公网流量只有 2.91 元，钱都花在"机器按小时计费"上（三台机上半月都是按量，下半月才转包月，所以 9 月看起来特别贵，属一次性叠加）。

已充值后余额：主账号 336.71、evallab 199.41。
**待办**：两个账号都设余额提醒（低于 100 元短信）；11 月 10/15 日前续费，三台约 380 元/月。

---

## 6. 本轮代码改动

**EvalOS 仓库**
- `infra/twin/opsmind_langgraph_labctl.py`：网络取证不再钉死控制器 Git 提交号，改按 RELEASE.json 发布清单摘要放行（+4 条回归）
- `infra/twin/test_controller_release.py`：新增 `InstallerCoverageTest`，安装器用例跑不了就**失败**，要跳过必须显式设 `OPSMIND_TWIN_ALLOW_SKIPPED_INSTALLER_TESTS=1`
- `packages/agent-runtime/test/adapter.test.mjs`：任何用例之前清掉 `ANTHROPIC_*`
- `services/control-api/test/deployment-installer.test.mjs`：不再信 `where git` 第一条命中，探测候选取真实存在的 bash
- `config/*.json`：AH 冻结版本跟进到 `7b1123a8`

**AH 仓库**
- `services/agent-service/tests/conftest.py`：**删掉**自造的 `tmp_path` 覆盖（改用 pytest 自带），并在**模块级**清掉 `ANTHROPIC_*`（收集期就要清，autouse fixture 来不及）
- `.dockerignore`：排除 `services/agent-service/tests`，并把 `.dockerignore` 纳入构建上下文（旧构建上下文根本没带它，等于摆设）

**LangGraph 仓库**：本轮未改（`697a826a` 是上一轮的检查点读取修复）

---

## 7. 现基线（本地验收）

| 仓库 | 基线 | 备注 |
|---|---|---|
| AH | **404 passed / 3 skipped** | `ANTHROPIC_BASE_URL` 仍导出也不影响，不用再手工清 |
| EvalOS | **238 passed / 0 failed / 0 skipped** | **Git Bash 下也通过**，不用再强制 PowerShell |
| EvalOS `infra/twin`（WSL） | **196 passed / 1 skipped** | Windows 上会**直接红**并提示去 Linux 跑 |

详见 `docs/implementation/本地验收可信跑法_20260914.md`（已更新）。

---

## 8. 遗留待办

**产品侧**
1. **LG 工作台与 AH 前端目前浏览器够不着**。LG 的 `/app` 在产品机上**已经在跑**（FastAPI 托管 `src/opsmind_langgraph/web/`，`/app` 返回 200）；AH 的 `apps/web/dist` 已构建但**没进镜像**。产品机对外**只开 22 端口**、无 nginx。要能访问需要：装 nginx + 申请证书 + 同样的密码锁 + 安全组开 443。**这是产品机首次接受公网入站，属攻击面实质变化，需先出方案再动手。**
2. `business_status` 标签把"已验证未恢复(false)"与"无法验证(None)"混成 `unknown`。评分读的是原始契约对象（`business_verification.passed`），**不受影响**；改它要动 AH → 重跑链路①③。
3. 外部爬虫（Googlebot、苹果网段）请求过**账本里真实存在的** trial URL（`trial_0c52534155a06c65adb7`、`trial_15dc4a63a44ed32eb761`），说明链接在某时点泄漏过。加密码后已挡住，但值得单独排查泄漏源。

**运维侧**

4. Phase 0-B 余下部分：最新一代备份仍是 19 GB 未压缩（策略是"最新一代保原样、更旧的压缩"）。上一代已压 19 GB → 731 MB。
5. AH 工作区有一个**被删除的 .docx** 待你确认：`材料/OpsMind_AgentHarness故障复盘与面试讲述指南_v1.0_20260821.docx`，盘上不在了、Git 里还在，`git checkout -- 材料/` 可恢复。我没有提交这个删除。
6. 控制台截图未取回本地（云助手输出长度限制，需分块传）。服务器上那份完整。

---

## 9. 必读：踩过的坑

`_work/claude-takeover-20260911/tools/RUNBOOK_四条链路操作手册.md` 第 5 节，本轮新增/更新了：

- **坑 6**：云助手重试必须带 `--ClientToken`。回包丢失 ≠ 命令没执行；不带 token 的重试会让同一段脚本在主机上**跑两遍**（本轮就让"拼装发布包 + 启动安装器"跑了两遍）。`ca.sh`/`ca-eval.sh` 已在重试循环**外**生成一个 token 并复用，实测验证过正反两个方向。**不要把 token 挪进循环里。**
- **坑 8**：EvalOS 备份保留策略（最新一代保原样、更旧的 zstd 压缩，解压 sha256 比对通过才删原件）
- **坑 9**：控制台有三道关（阿里云 ICP 备案拦截 / nginx 访问控制 / 只监听 loopback），别只查一道

另外两条重要事实：

- **Claude Code 就跑在操作者本机**，出口 IP 与操作者浏览器完全相同。所谓"沙箱"不是另一台机器。安全组里那些 `OpsMind-Codex-SSH` 的 `/32` 规则失效，是**操作者 IP 变了**，不是工具差异。
- `OpsMind-LangGraph` 顶层目录是废弃的独立 clone，正确目录是
  `OpsMind-LangGraph/runtime/codex-migration-20260903/candidates/report-evidence`。
  LG 的前端在 `src/opsmind_langgraph/web/`，**不在 `apps/` 下**——按目录名搜会漏掉。

---

## 10. 边界（延续，未变）

不改评分权重、不删真实失败、不伪造根因/回滚/验证、不改写 Git 历史、不 force push、不删远端分支或标签。
不为了跑通验收而放宽安全控制（本轮拒绝过：给 nginx 放行沙箱 IP、放行共享 VPN 出口）。
