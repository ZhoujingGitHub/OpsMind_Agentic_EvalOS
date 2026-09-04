# 实验室源码归属迁移

本次将原 AH 仓库在实验室执行的四个文件及四项控制器测试迁入 EvalOS 的 infra/twin。
迁移来源为 ZhoujingGitHub/OpsMind 的 ccda64e035f3467a152185b4c452034c53297ff7。
逐文件原路径、新路径和 LF 内容 SHA256 见 harness-source-lineage.json；四份内容与 2026-09-04 本次读取的线上文件摘要一致。
AH 产品客户端、Claude Agent SDK 单 Agent、MCP 和自主调查循环仍归 AH，产品不依赖本仓库源码路径。

此次源码搬迁与随后的网络行为、发布入口改造分提交。仅此搬迁提交不是已经完成的发布版本。
AH 原 install-protocol-lab.sh 和 install_harness_protocol_lab.ps1 随对应 AH 迁移提交退役。
最终交付使用本目录 build-controller-release.py / install-controller.sh 管理完整实验室组件与两代回退；
安装和身份配置由该唯一入口负责，不能重新部署退役脚本或保留第二份生效实现。
现有身份、绑定秘密、密钥、运行证据不随源码迁移，不写入本清单或 Git。
