// Real end-to-end check of the three demo consoles, driven through the operator's
// own Chrome from the operator's own network. This is the layer curl cannot reach:
// it executes the page JavaScript, so it answers the question the loopback tests
// could not -- does the AH single-page app actually render and wire itself up?
//
// Run:  node e2e-consoles.mjs            (headless)
//       node e2e-consoles.mjs --headed   (watch it)
//
// Basic-auth credentials are read from 演示口令_20260916.txt at the project root.
// They are never printed. Application-level tenant logins are NOT attempted: those
// credentials belong to the operator and are not in this repo or this session.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));

// playwright-core 只装在 AH 仓的 apps/web 里，不为这个脚本单独装一份依赖。
const AH_WEB = resolve(HERE, "../../../../OpsMind/apps/web/package.json");
if (!existsSync(AH_WEB)) throw new Error(`找不到 ${AH_WEB}（playwright-core 从这里解析）`);
const { chromium } = createRequire(pathToFileURL(AH_WEB).href)("playwright-core");
const ROOT = resolve(HERE, "../../../..");
const PWFILE = resolve(ROOT, "演示口令_20260916.txt");
const SHOTS = resolve(HERE, "../e2e-consoles-20260916");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const HEADED = process.argv.includes("--headed");

function creds(label) {
  const text = readFileSync(PWFILE, "utf8");
  const block = text.split(label)[1];
  if (!block) throw new Error(`口令文件里找不到 ${label}`);
  const user = block.match(/账号\s+(\S+)/)?.[1];
  const pass = block.match(/口令\s+(\S+)/)?.[1];
  if (!user || !pass) throw new Error(`${label} 的账号或口令解析失败`);
  return { username: user, password: pass };
}

// 开关由脚本自己管，这样关闭态与开放态在同一次运行里都被测到，
// 而且无论结果如何最后都会关回去。
function demoWindow(action) {
  console.log("[demo-window] " + action + " ...");
  const out = execFileSync("bash", ["demo-window.sh", action], { cwd: HERE, encoding: "utf8" });
  const lines = out.split(/\r?\n/).filter((l) => l.includes("状态=") || l.includes("未配置"));
  for (const l of lines) console.log("   " + l.trim());
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: !HEADED });

try {
  // ---- 1. 关闭态必须是硬 403，连凭据都不看 -------------------------------
  {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: false });
    const page = await ctx.newPage();
    for (const [label, url] of [
      ["EvalOS", "https://121-40-223-202.sslip.io/"],
      ["LG", "https://lg.114-55-40-170.sslip.io/app"],
      ["AH", "https://ah.114-55-40-170.sslip.io/"],
    ]) {
      const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => e);
      const status = r?.status?.() ?? `错误 ${r?.message?.slice(0, 40)}`;
      check(`${label} 关闭态 = 403`, status === 403, `实得 ${status}`);
    }
    await ctx.close();
  }

  demoWindow("open");

  // ---- 2. 开放态：三个入口带凭据都能进 ----------------------------------
  const lg = creds("LG 工作台");
  const ah = creds("AH 工作台");

  // 2a. LG 工作台：后端自托管的页面必须真的跑起来
  {
    const ctx = await browser.newContext({ httpCredentials: lg });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const r = await page.goto("https://lg.114-55-40-170.sslip.io/app", { waitUntil: "networkidle", timeout: 60000 });
    check("LG /app HTTP 200", r.status() === 200, `实得 ${r.status()}`);
    check("LG 证书有效（无 TLS 错误）", true, "ignoreHTTPSErrors=false 下加载成功");
    const hasLogin = await page.locator("#login-dialog").count();
    check("LG 登录对话框存在（app.js 已执行）", hasLogin > 0, `#login-dialog 数量 ${hasLogin}`);
    const title = await page.title();
    check("LG 页面标题非空", title.length > 0, JSON.stringify(title));
    check("LG 无未捕获 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({ path: `${SHOTS}/01-lg-workbench.png`, fullPage: true });
    await ctx.close();
  }

  // 2b. AH 工作台：这是本轮唯一没被验过的东西
  {
    const ctx = await browser.newContext({ httpCredentials: ah });
    const page = await ctx.newPage();
    const errors = [];
    const apiCalls = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (q) => {
      if (q.url().includes("/v2/")) apiCalls.push(`${q.method()} ${q.url()}`);
    });

    const r = await page.goto("https://ah.114-55-40-170.sslip.io/", { waitUntil: "networkidle", timeout: 60000 });
    check("AH 首页 HTTP 200", r.status() === 200, `实得 ${r.status()}`);

    // React 真的挂载了吗（curl 只能看到空的 <div id="root">）
    const rootKids = await page.evaluate(() => document.getElementById("root")?.childElementCount ?? -1);
    check("AH React 已挂载（#root 有子节点）", rootKids > 0, `子节点数 ${rootKids}`);

    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
    check("AH 渲染出可见文案", bodyText.trim().length > 10, JSON.stringify(bodyText.slice(0, 80)));

    // 构建期烧进去的 API 地址必须是同源的公网地址，不能是 127.0.0.1
    const apiRoot = await page.evaluate(() =>
      [...document.scripts].map((s) => s.src).join(",")
    );
    check("AH 资源来自同源", apiRoot.includes("ah.114-55-40-170.sslip.io"), apiRoot.slice(0, 90));
    const bad = apiCalls.filter((u) => u.includes("127.0.0.1"));
    check("AH 没有打向 127.0.0.1 的请求", bad.length === 0, bad.slice(0, 2).join(" | "));

    // 未登录的 SPA 只渲染登录页，不会自己发 API 请求，所以主动从页面里发一次同源相对
    // 请求。这一条验的是三件事连起来：浏览器认为它同源（不发跨域预检）、nginx 的 /v2/
    // 反代通到应用、应用自己的鉴权在工作（401）。
    const probe = await page.evaluate(async () => {
      try {
        const r = await fetch("/v2/auth/me", { headers: { "Content-Type": "application/json" } });
        return { status: r.status, origin: new URL("/v2/auth/me", location.href).origin };
      } catch (e) {
        return { error: String(e) };
      }
    });
    check("AH 同源 /v2/ 反代通且应用鉴权在工作（401）", probe.status === 401, JSON.stringify(probe));
    check("AH 的 /v2/ 请求确实是同源", probe.origin === "https://ah.114-55-40-170.sslip.io", String(probe.origin));

    // /health 是前端唯一一个不在 /v2/ 下的接口（client.ts:118）。nginx 少配这一条时
    // 它会落到静态 location 的 try_files 上拿回 index.html，前端把 HTML 当 JSON 解析
    // 就报 `Unexpected token '<'`。这条断言是第一轮实测到该缺陷后补的。
    const health = await page.evaluate(async () => {
      try {
        const r = await fetch("/health");
        const ct = r.headers.get("content-type") || "";
        const head = (await r.text()).slice(0, 40);
        return { status: r.status, ct, head };
      } catch (e) {
        return { error: String(e) };
      }
    });
    check("AH /health 返回 JSON 而不是 index.html",
      health.status === 200 && health.ct.includes("json") && !health.head.includes("<!doctype"),
      JSON.stringify(health));

    // 上面那些断言全绿时页面仍可能是坏的：/health 的失败被前端捕获并显示在界面上，
    // 所以它既不是未捕获异常、也不影响 HTTP 状态码。必须直接看页面上有没有报错。
    const visibleError = await page.evaluate(() => {
      const t = document.body.innerText;
      const hits = ["is not valid JSON", "Unexpected token", "Failed to fetch", "API 5", "NetworkError"]
        .filter((k) => t.includes(k));
      return hits;
    });
    check("AH 页面上没有可见报错", visibleError.length === 0, visibleError.join(" | "));
    check("AH 无未捕获 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({ path: `${SHOTS}/02-ah-login.png`, fullPage: true });

    // 深链接刷新：BrowserRouter 必须靠 try_files 回退
    const r2 = await page.goto("https://ah.114-55-40-170.sslip.io/investigations/probe-only", {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    check("AH 深链接刷新 HTTP 200（try_files 生效）", r2.status() === 200, `实得 ${r2.status()}`);
    const rootKids2 = await page.evaluate(() => document.getElementById("root")?.childElementCount ?? -1);
    check("AH 深链接下 React 仍挂载", rootKids2 > 0, `子节点数 ${rootKids2}`);
    await page.screenshot({ path: `${SHOTS}/03-ah-deeplink.png`, fullPage: true });
    await ctx.close();
  }

  // 2c. EvalOS 控制台。它的口令是运营方原有的、不在本会话里，所以只验到"要凭据"这一层。
  //     注意：page.goto 碰到 401 挑战而手里没有凭据时会抛 ERR_INVALID_AUTH_CREDENTIALS
  //     而不是返回响应，所以状态码要用 context.request 取。
  {
    const ctx = await browser.newContext();
    const r = await ctx.request.get("https://121-40-223-202.sslip.io/", {
      timeout: 45000,
      failOnStatusCode: false,
    });
    check("EvalOS 开放态要求凭据（401）", r.status() === 401, `实得 ${r.status()}`);
    await ctx.close();
  }

  // ---- 3. 不该可达的东西 ------------------------------------------------
  {
    const ctx = await browser.newContext();
    let unreachable = false;
    let detail = "";
    try {
      const r = await ctx.request.get("http://lg.114-55-40-170.sslip.io/", {
        timeout: 20000,
        failOnStatusCode: false,
      });
      detail = `竟然返回 ${r.status()}`;
    } catch (e) {
      unreachable = true;
      detail = "连接失败，符合预期：" + String(e.message).split("\n")[0].slice(0, 60);
    }
    check("产品机 80 端口不可达（我们不开 80）", unreachable, detail);
    await ctx.close();
  }
} finally {
  try { demoWindow("close"); } catch (e) { console.log("!! 关闭开关失败，请手工跑 ./demo-window.sh close —— " + e.message); }
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`);
console.log(`截图: ${SHOTS}`);
if (failed.length) {
  console.log("未通过:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
