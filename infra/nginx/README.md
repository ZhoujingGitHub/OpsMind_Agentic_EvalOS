# 控制台 nginx 配置

三个演示入口。**入口默认关闭**，演示前后用
`_work/claude-takeover-20260911/tools/demo-window.sh open|close|status` 开关。

| 入口 | 主机 | 配置 | 后端 |
|---|---|---|---|
| EvalOS 控制台 | `121.40.223.202` | `opsmind-evalos.conf` | `127.0.0.1:3000` |
| LG 工作台 | `114.55.40.170` | `opsmind-lg.conf` | `127.0.0.1:8081` |
| AH 工作台 | `114.55.40.170` | `opsmind-ah.conf` + `/srv/opsmind-ah-web` 静态 | `127.0.0.1:8000` |

## 不在 Git 里的东西

- `/etc/nginx/opsmind-*.htpasswd` —— 口令哈希。**永远不入 Git。**
  用 `openssl passwd -apr1` 在操作者本机算哈希，只把哈希送上服务器；明文不经过
  会话记录、Git 或云助手命令。
- `/etc/nginx/opsmind-*-access.conf` —— 演示窗口开关的**当前状态**。
  常态是 `deny all;`。`*.open` 后缀的同名文件是开放态模板。
- `/etc/nginx/ssl/opsmind-*/` —— 证书与私钥，由 acme.sh 管理。

## 关闭态是硬 403，不是 401

`deny all;` 与 `auth_basic` 同时存在时，nginx 的 access 阶段先于认证阶段生效，
**即使带正确口令也拿不到内容**。2026-09-16 在 EvalOS 机上用隔离回环 vhost 实测过
deny / auth / 两者兼有 共 7 种组合：两者兼有时匿名、错误口令、正确口令一律 403。

附带两条当时踩到的 nginx 事实：

- `return 200` 属于 rewrite 阶段，**在 access 阶段之前**，所以用 `return` 做探针
  会绕过 `deny`/`auth_basic`，测不出真实行为。要用静态文件或 `proxy_pass`。
- `systemctl reload nginx` 是**异步**的。紧跟其后的请求可能还打在旧 worker 上，
  验证前要等几秒。

## 不开 80（产品机）

acme.sh 用 TLS-ALPN-01，签发与续期只需 443；而 80 在大陆公网会被阿里云 ICP
拦截页替换，对浏览器也没用。代价是漏打 `https://` 会得到"连接被拒绝"。
EvalOS 那台的 80 块是历史遗留（301 跳转 + 已不使用的 acme-challenge root）。

## 证书续期

`infra/acme/opsmind-renew-cert.sh` + `infra/systemd/opsmind-cert-renew.{service,timer}`，
**两台机同一份脚本**，差异只在 `/etc/opsmind-cert-renew.conf`。
`sslip.io` 不在公共后缀列表里，全球共享一个 Let's Encrypt 额度，所以续期可能失败——
脚本在失败时留 `RENEW_FAILED` 标记、写 journal、并以非零码退出。
