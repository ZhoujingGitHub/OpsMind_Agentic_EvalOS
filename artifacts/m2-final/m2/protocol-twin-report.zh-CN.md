# OpsMind Agentic EvalOS M2 真实协议数字孪生验收报告

- 结论：**PASSED**
- 运行编号：`m2-real-acceptance-20260814-v3`
- Case：20/20 通过
- 稳定基线哈希：`baf90fa1341b5c8e510e4e37319a037a90b460d1b0bf1066e5f84a288d335d26`
- 最大磁盘占用：0.16%

## 口径

本报告只把真实 Open5GS、MongoDB、UERANSIM 组件运行、真实 PCAP、真实故障观测和清洁复位计入 M2。模拟脑与回放替身不计入。

## 门禁

- 通过：real_components_ready
- 通过：initial_baseline_clean
- 通过：all_20_cases_executed
- 通过：all_20_cases_passed
- 通过：every_trial_has_pcap
- 通过：every_trial_reset_clean
- 通过：reset_hash_is_deterministic
- 通过：final_baseline_clean
- 通过：disk_capacity_safe
