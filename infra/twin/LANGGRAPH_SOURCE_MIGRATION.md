# LangGraph 实验室源码归属迁移

本次将原 LG 仓库在实验室执行的四个文件迁入 EvalOS 的 infra/twin，与 AH 同一处置。
迁移来源为 ZhoujingGitHub/OpsMind-LangGraph 的 e34773bd0484b33bf0c101d70d1262fd67190447。
逐文件原路径、新路径和 LF 内容 SHA256 见 langgraph-source-lineage.json；四份内容与 2026-09-14 本次读取的线上文件摘要一致。
LG 产品侧 Graph、双模型分工、Checkpoint、Evidence Gate 与审批票据仍归 LG，产品不依赖本仓库源码路径。

此次源码搬迁与随后的网络行为、发布入口改造分提交。仅此搬迁提交不是已经完成的发布版本。
LG 原 deploy/protocol_lab/install-protocol-lab.sh 随对应 LG 迁移提交退役，包括其 --gateway-only / --gateway-rollback 两个旁路安装模式。
最终交付使用本目录 build-controller-release.py / install-controller.sh 管理完整实验室组件与两代回退；
版本安装由该唯一入口负责；现有身份和权限继续由主机安全配置管理，升级不创建账号或改权限。不能重新部署退役脚本或保留第二份生效实现。
现有身份、绑定秘密、密钥、运行证据不随源码迁移，不写入本清单或 Git。

搬迁提交的产物是控制器「接管归属」用的 adoption 发布包：其四份 LG 文件与线上裸文件逐字节一致，
因此 install-controller.sh 可以在不改变任何实验室行为的前提下把这四个路径转为受控软链，
随后的行为修改提交才构成真正的新一代版本，两代回退因此成立。

## 实验室主机上保留为主机配置的部分

与 AH 的 `/etc/opsmind-harness-lab/*.conf` 同一处置，下列文件继续由主机安全配置维护，不进发布包：

| 路径 | 2026-09-14 实测 SHA-256 |
|---|---|
| `/etc/opsmind-langgraph-lab/protocol-actions.json` | `38aa974fc2e42de544e15ecd0bccaae091f1e50ddddaa14ed11931cc65f554b2` |
| `/etc/opsmind-langgraph-lab/dnsmasq.conf` | `a1f88ad49207d0c5cfaa80cb87995b65a9a96a606c1eca1105fa26ecaf46f8a2` |
| `/etc/opsmind-langgraph-lab/mosquitto.conf` | `0f42d70c320fd270d312e0938b1bc26db3bfd7e2316f86471e6456fe6f84a24a` |

四个产品 SSH 身份、`authorized_keys`、`sudoers` 同样不随发布包变更，升级不创建账号、不改权限。

### 已知的摘要不可重现问题（已在 LG 仓库前向修复）

线上 `protocol-actions.json` 的 10705 字节 / `38aa974f…`，是 LG 仓库 `e34773b` 中那份
10439 字节 / `0e73d728…` 的 **CRLF 变体**（266 行，正好差 266 字节）。两者是同一份 JSON，
逐字符等价，解析结果相同，因此线上动作目录并不陈旧；但该摘要只能由 Windows 工作区产出，
无法从 Git 在 Linux 上重现。LG 仓库已补 `.gitattributes` 的 `text eol=lf` 规则，
本仓库也已对 `infra/twin` 的发布负载补齐同类规则。

动作目录若今后需要变更，应在那一次把它作为受管文件加入控制器发布包（届时内容本就要变，
不存在与线上逐字节对齐的约束），而不是复活 `install-protocol-lab.sh`。
