# OpsMind M1 评测控制台

这是 OpsMind Agentic EvalOS 的 M1 Web 控制台，用于查看 G1 验收状态、实验摘要、Trial 列表和 Trace 事件。

## 运行要求

- Node.js `>=22.13.0`，推荐使用项目要求的 Node.js 24 或更高版本。

## 常用命令

```text
npm install
npm run dev
npm run build
npm test
```

- `npm run dev`：启动本地开发环境。
- `npm run build`：构建并验证控制台。
- `npm test`：构建控制台并验证服务端渲染结果。

## 数据来源

控制台当前读取 `public/m1-snapshot.json` 与 `public/m1-manifest.json` 中的 M1 验收快照。执行根目录的 `npm run accept:m1` 后，验收脚本会同步更新这两份快照。

## 登录与部署

项目保留 Sites 的可选登录和部署能力。访客身份来自平台注入的请求头；业务页面不自行实现平台保留的登录、退出和回调路由。M1 当前控制台为只读验收界面，不依赖用户身份即可展示本地快照。
