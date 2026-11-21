/**
 * dsh-piliaurora-wall — 宿主半
 *
 * 职责：
 *   1. 起停「PiliAurora 多窗口服务」(`wall_server.py`) —— 它自己实现 PiliAurora
 *      的多进程播放窗口协议（回环 WebSocket + token 握手），把 N 个播放窗口
 *      先创建在屏幕外，再延迟搬运到网格位，全程不需要鼠标/截图/UIA。
 *   2. 抓「视频池」(`fetch_pool.py`) —— 按用户关键词搜 bilibili，写 pool.json。
 *   3. 把面板上的按钮转发成命令（写 wall/cmd.json，等 wall/result.json 回显）。
 *   4. 依赖自愈 + 路径配置：脚本目录/Python/PiliAurora.exe 全部可配、可探测、
 *      可自动拉起，配置文件在 ~/.dsh/piliaurora-wall.config.json。
 *
 * 对外路由（前缀 /piliaurora-wall）：
 *   GET  /status          -> 服务状态 + 窗口列表 + 依赖探测（deps）
 *   GET  /config          -> 当前配置 + 探测结果
 *   POST /config          -> {exePath?, autoDir?, pythonPath?, autoLaunch?} 保存配置
 *   POST /open            -> {keyword?, count?, volume?, search?, launch?} 抓池 + 起服务 + 开窗
 *   POST /cmd             -> {action, value} 透传命令（mute_all/next_batch/hide_all/…）
 *   POST /launch          -> 启动 PiliAurora.exe（宿主自己拉起，不等用户点）
 *   POST /resolve-lnk     -> {lnk} 解析 .lnk 的 TargetPath
 *   POST /pick-exe        -> 弹系统文件选择框挑 exe/lnk
 *   POST /open-url        -> {url} 用系统浏览器打开（只放行 https://github.com）
 *   POST /stop            -> 关窗并停服务
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-piliaurora-wall";
export const inject = ["webServer"];

const VERSION = "0.2.2";
const ROUTE = "/piliaurora-wall";

// 本插件包自己的 package.json（junction 指回 local-plugins 源目录，磁盘真实版本）
// 注意：本文件是 ESM（package.json type:module），没有 __dirname，必须用 import.meta.url 派生
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_F = path.join(THIS_DIR, "..", "package.json");
// 内置脚本兜底目录（发布包里带 scripts/wall_server.py + fetch_pool.py）
const BUNDLED_DIR = path.join(THIS_DIR, "..", "scripts");
const CFG_F = path.join(os.homedir(), ".dsh", "piliaurora-wall.config.json");
// 兜底数据目录：外部脚本全找不到时，把内置脚本复制到这里再跑（脚本目录必须等于数据目录）
const HOME_AUTO = path.join(os.homedir(), ".dsh", "piliaurora-auto");
const DEFAULT_EXE = "D:\\Program Files (x86)\\pili_aurora\\PiliAurora.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), "utf8");
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

function json(res, obj, code = 200) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// ---------------- 配置 ----------------

function loadCfg() {
  const c = readJson(CFG_F);
  return c && typeof c === "object" ? c : {};
}

function saveCfg(patch) {
  const next = { ...loadCfg(), ...patch };
  writeJson(CFG_F, next);
  return next;
}

function probeScripts(dir) {
  if (!dir) return false;
  try {
    return (
      fs.existsSync(path.join(dir, "wall_server.py")) &&
      fs.existsSync(path.join(dir, "fetch_pool.py"))
    );
  } catch {
    return false;
  }
}

/** 脚本目录候选：用户配置 > 环境变量 > 历史路径 > 用户数据目录 > 插件包内置 */
function autoCandidates() {
  const cfg = loadCfg();
  const out = [];
  if (cfg.autoDir) out.push(String(cfg.autoDir));
  if (process.env.PILIAURORA_AUTO_DIR) out.push(String(process.env.PILIAURORA_AUTO_DIR));
  out.push(
    "E:\\dsh-tmp\\piliaurora-auto",
    "E:\\DSH\\tmp\\dsh-tmp\\piliaurora-auto",
    HOME_AUTO,
    BUNDLED_DIR,
  );
  return out;
}

/** 把内置脚本安装到用户数据目录（外部目录全失效时自愈，避免"插件装了但永远缺脚本"） */
function healBundled() {
  try {
    fs.mkdirSync(HOME_AUTO, { recursive: true });
    for (const f of ["wall_server.py", "fetch_pool.py"]) {
      const src = path.join(BUNDLED_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(HOME_AUTO, f));
    }
    return probeScripts(HOME_AUTO);
  } catch {
    return false;
  }
}

let _pathsCache = { at: 0, key: "", val: null };

/** 解析脚本/数据目录（脚本目录 == 数据目录，pool.json 与 wall/ 都落在同级） */
function paths() {
  let key = "0";
  try {
    key = String(fs.statSync(CFG_F).mtimeMs);
  } catch {
    /* ignore */
  }
  key += `|${process.env.PILIAURORA_AUTO_DIR || ""}`;
  if (_pathsCache.val && _pathsCache.key === key && Date.now() - _pathsCache.at < 60000) {
    return _pathsCache.val;
  }
  const cands = autoCandidates();
  let picked = null;
  for (const c of cands) {
    if (probeScripts(c)) {
      picked = c;
      break;
    }
  }
  let healed = false;
  if (!picked && healBundled()) {
    picked = HOME_AUTO;
    healed = true;
  }
  const auto = picked || cands[0] || HOME_AUTO;
  const wall = path.join(auto, "wall");
  const val = {
    auto,
    ok: !!picked,
    healed,
    probed: cands,
    wall,
    cmd: path.join(wall, "cmd.json"),
    res: path.join(wall, "result.json"),
    stat: path.join(wall, "status.json"),
    log: path.join(wall, "wall.log"),
    poolMeta: path.join(wall, "pool.meta.json"),
    poolJson: path.join(auto, "pool.json"),
    serverPy: path.join(auto, "wall_server.py"),
    poolPy: path.join(auto, "fetch_pool.py"),
  };
  _pathsCache = { at: Date.now(), key, val };
  return val;
}

// ---------------- Python ----------------

/** 本机 `python` 命令指向 WindowsApps 存根（未安装时会报错），必须解析到真实解释器
 *  优先 pythonw.exe：pythonw 不创建控制台，Windows 上每次开窗排列才不会闪黑窗。
 *  顺序：配置 > env PILIAURORA_PYTHON > 候选目录里的 pythonw.exe > 同目录 python.exe > "py" */
function resolvePython() {
  const cfg = loadCfg();
  if (cfg.pythonPath) return String(cfg.pythonPath);
  const fromEnv = process.env.PILIAURORA_PYTHON;
  if (fromEnv) return fromEnv;
  const candidates = [
    "E:\\Python311\\python.exe",
    "E:\\Python312\\python.exe",
    "E:\\Python313\\python.exe",
    "C:\\Python311\\python.exe",
    "C:\\Python312\\python.exe",
  ];
  // 第一轮：同目录的 pythonw.exe（无控制台窗口）
  for (const c of candidates) {
    const w = c.replace(/python\.exe$/i, "pythonw.exe");
    try {
      if (fs.existsSync(w)) return w;
    } catch {
      /* ignore */
    }
  }
  // 第二轮：退回到 python.exe
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "py";
}

let _pyCache = { at: 0, v: "" };

function pythonExe() {
  if (_pyCache.v && Date.now() - _pyCache.at < 30000) return _pyCache.v;
  const v = resolvePython();
  _pyCache = { at: Date.now(), v };
  return v;
}

function pythonOk(p) {
  if (!p) return false;
  // 裸命令（py / python）交给运行时；绝对路径必须存在
  if (!/[\\/]/.test(p)) return true;
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// ---------------- PiliAurora.exe ----------------

const _lnkCache = new Map();

/** 解析 Windows 快捷方式的目标路径（结果按 mtime 缓存，避免每次探活都起 PowerShell） */
function readLnkSync(lnk) {
  try {
    if (!lnk || !fs.existsSync(lnk)) return "";
    const mt = fs.statSync(lnk).mtimeMs;
    const hit = _lnkCache.get(lnk);
    if (hit && hit.mt === mt) return hit.target;
    const q = String(lnk).replace(/'/g, "''");
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q}'); if($s.TargetPath){$s.TargetPath}`,
      ],
      { windowsHide: true, encoding: "utf8", timeout: 8000 },
    );
    const t = (r && r.stdout ? String(r.stdout) : "").trim();
    _lnkCache.set(lnk, { mt, target: t });
    return t;
  } catch {
    return "";
  }
}

const EXE_CANDIDATES = [
  DEFAULT_EXE,
  "D:\\Program Files\\pili_aurora\\PiliAurora.exe",
  "C:\\Program Files (x86)\\pili_aurora\\PiliAurora.exe",
  "C:\\Program Files\\pili_aurora\\PiliAurora.exe",
  "E:\\Program Files (x86)\\pili_aurora\\PiliAurora.exe",
];

function lnkCandidates() {
  return [
    path.join(os.homedir(), "Desktop", "PiliAurora.lnk"),
    path.join(os.homedir(), "Desktop", "快捷方式", "PiliAurora.lnk"),
    "C:\\Users\\Public\\Desktop\\PiliAurora.lnk",
  ];
}

/** 返回 {path, source, lnk?}；source = config|config-lnk|auto|lnk|none */
function resolveExe() {
  const cfg = loadCfg();
  if (cfg.exePath) {
    const p = String(cfg.exePath);
    if (/\.lnk$/i.test(p)) {
      const t = readLnkSync(p);
      if (t) return { path: t, source: "config-lnk", lnk: p };
    } else {
      try {
        if (fs.existsSync(p)) return { path: p, source: "config" };
      } catch {
        /* ignore */
      }
    }
  }
  for (const c of EXE_CANDIDATES) {
    try {
      if (fs.existsSync(c)) return { path: c, source: "auto" };
    } catch {
      /* ignore */
    }
  }
  for (const l of lnkCandidates()) {
    const t = readLnkSync(l);
    if (t && fs.existsSync(t)) return { path: t, source: "lnk", lnk: l };
  }
  return { path: cfg.exePath ? String(cfg.exePath) : "", source: "none" };
}

let _exeRun = { at: 0, exe: "", running: false, pid: 0 };

/** PiliAurora.exe 是否在运行（tasklist，10s 缓存，异步不阻塞；缓存放长避免面板 2s 轮询反复起进程） */
function probeExeRunning(exePath) {
  return new Promise((resolve) => {
    if (!exePath) {
      resolve(false);
      return;
    }
    if (Date.now() - _exeRun.at < 10000 && _exeRun.exe === exePath) {
      resolve(_exeRun.running);
      return;
    }
    const base = path.basename(exePath);
    let child;
    try {
      child = spawn("tasklist", ["/FI", `IMAGENAME eq ${base}`, "/FO", "CSV", "/NH"], {
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let out = "";
    let done = false;
    const finish = (running, pid) => {
      if (done) return;
      done = true;
      _exeRun = { at: Date.now(), exe: exePath, running, pid: pid || 0 };
      resolve(running);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(false, 0);
    }, 3000);
    child.stdout.on("data", (b) => {
      out += b.toString("utf8");
      if (out.length > 4000) out = out.slice(-2000);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const m = /"([^"]+)","(\d+)"/.exec(out);
      finish(!!m, m ? Number(m[2]) : 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(false, 0);
    });
  });
}

/** 启动 PiliAurora.exe（detached：DSH 退出不连带；GUI 程序不会闪控制台） */
function launchExe(exePath) {
  return new Promise((resolve) => {
    if (!exePath) {
      resolve({ ok: false, error: "还没配置 PiliAurora.exe 路径" });
      return;
    }
    try {
      if (!fs.existsSync(exePath)) {
        resolve({ ok: false, error: `找不到程序：${exePath}` });
        return;
      }
    } catch {
      /* ignore */
    }
    let child;
    try {
      child = spawn(exePath, [], {
        cwd: path.dirname(exePath),
        stdio: "ignore",
        detached: true,
        windowsHide: false,
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.on("error", (e) => done({ ok: false, error: String((e && e.message) || e) }));
    child.on("spawn", () => {
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      done({ ok: true, pid: child.pid || null });
    });
    setTimeout(() => {
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      done({ ok: true, pid: child.pid || null, slow: true });
    }, 8000);
  });
}

// ---------------- 依赖探测（/open 前置） ----------------

/**
 * 检查三个依赖：脚本目录 / Python / PiliAurora.exe。
 * 脚本与 Python 缺失属于阻塞项；exe 未运行只在 autoLaunch 时尝试拉起，不阻塞开窗
 * （播放窗是独立 player-window 进程，主程序没在前台也能起，失败时再提示）。
 */
async function ensureReady({ autoLaunch = true } = {}) {
  const p = paths();
  const exe = resolveExe();
  const py = pythonExe();
  const deps = {
    scriptsOk: p.ok,
    scriptsDir: p.auto,
    scriptsHealed: p.healed,
    probed: p.probed,
    exe: exe.path || "",
    exeSource: exe.source,
    exeExists: !!(exe.path && fs.existsSync(exe.path)),
    exeRunning: false,
    exePid: 0,
    python: py,
    pythonOk: pythonOk(py),
    missing: [],
    blocking: [],
  };
  if (!deps.scriptsOk) {
    deps.missing.push({
      code: "scripts_missing",
      message: `服务脚本缺失：${p.auto} 下没有 wall_server.py / fetch_pool.py`,
      fix: "到「设置」里指定服务脚本目录，或留空让插件自动探测",
    });
  }
  if (!deps.pythonOk) {
    deps.missing.push({
      code: "python_missing",
      message: `Python 解释器不可用：${py}`,
      fix: "到「设置」里填 python.exe 的完整路径",
    });
  }
  if (!deps.exeExists) {
    deps.missing.push({
      code: "exe_missing",
      message: "找不到 PiliAurora.exe",
      fix: "到「设置」里填程序路径或桌面快捷方式路径",
    });
  } else {
    deps.exeRunning = await probeExeRunning(exe.path);
  }
  deps.blocking = deps.missing.filter(
    (m) => m.code === "scripts_missing" || m.code === "python_missing",
  );
  let launched = null;
  if (autoLaunch && deps.exeExists && !deps.exeRunning) {
    launched = await launchExe(exe.path);
    if (launched.ok) {
      await sleep(3500);
      deps.exeRunning = await probeExeRunning(exe.path);
      if (deps.exeRunning) _exeRun = { ..._exeRun, running: true };
    }
  }
  return { p, deps, exe, py, launched };
}

// ---------------- 服务控制 ----------------

/** 写命令并等回显（server 会把同 id 的结果写进 result.json） */
async function sendCmd(action, value, timeoutMs = 20000) {
  const p = paths();
  const prev = readJson(p.cmd);
  const id = Math.max(Number(prev && prev.id) || 0, Date.now()) + 1;
  if (!writeJson(p.cmd, { id, action, value })) {
    return { ok: false, error: "无法写入 wall/cmd.json" };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = readJson(p.res);
    if (r && Number(r.id) === id) return r;
    await sleep(150);
  }
  return { ok: false, error: `等 wall_server 回应超时（${action}）` };
}

let CHILD = null;
let probeCooldown = 0;

function childAlive() {
  return !!(CHILD && CHILD.exitCode === null && !CHILD.killed);
}

/** 状态新鲜度：wall_server 每次循环都会刷新 status.json */
function statusFresh(st, ms = 180000) {
  if (!st || !st.time) return false;
  const t = Date.parse(String(st.time).replace(" ", "T"));
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < ms;
}

function stopChild() {
  if (!CHILD) return;
  try {
    CHILD.kill();
  } catch {
    /* ignore */
  }
  CHILD = null;
}

function startServer(count, volume) {
  stopChild();
  const p = paths();
  const exe = resolveExe();
  const args = ["-u", p.serverPy, "--count", String(count)];
  if (typeof volume === "number" && Number.isFinite(volume)) args.push("--volume", String(volume));
  // 注意：不能用 detached: true —— Windows 上 detached 会新开一个控制台，
  // 每次「开窗排列」都会闪一个黑框。改成 pythonw + windowsHide（不建控制台）。
  const child = spawn(pythonExe(), args, {
    cwd: p.auto,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PILIAURORA_AUTO_DIR: p.auto,
      ...(exe.path ? { PILIAURORA_EXE: exe.path } : {}),
    },
  });
  child.on("exit", () => {
    if (CHILD === child) CHILD = null;
  });
  child.on("error", () => {
    if (CHILD === child) CHILD = null;
  });
  child.unref();
  CHILD = child;
  return { pid: child.pid || null, serverPy: p.serverPy, cwd: p.auto };
}

async function waitRunning(timeoutMs = 60000) {
  const p = paths();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readJson(p.stat);
    const wins = st && Array.isArray(st.windows) ? st.windows : [];
    if (wins.length > 0 && st.phase === "running") return st;
    await sleep(500);
  }
  return null;
}

/** 跑 fetch_pool.py 抓视频池
 *  用 pythonw 跑（不弹控制台），条数从 --meta 指定的 json 读；
 *  stdout 的 WROTE 正则只作兜底（pythonw 下 stdout 通常没有内容）。
 *  --out 显式指向脚本目录下的 pool.json：wall_server 只从那里读池子。 */
function runPool(keyword, limit) {
  return new Promise((resolve) => {
    const p = paths();
    const args = ["-u", p.poolPy];
    if (keyword) args.push("--keyword", keyword);
    if (limit) args.push("--limit", String(limit));
    args.push("--out", p.poolJson);
    args.push("--meta", p.poolMeta);
    // 旧 meta 必须先清掉，否则会把上一次的条数当成本次结果
    try {
      fs.mkdirSync(path.dirname(p.poolMeta), { recursive: true });
      fs.unlinkSync(p.poolMeta);
    } catch {
      /* ignore */
    }
    const child = spawn(pythonExe(), args, {
      cwd: p.auto,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PILIAURORA_AUTO_DIR: p.auto },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: "抓视频池超时（180s）" });
    }, 180000);
    child.stdout.on("data", (b) => {
      out += b.toString("utf8");
      if (out.length > 20000) out = out.slice(-10000);
    });
    child.stderr.on("data", (b) => {
      err += b.toString("utf8");
      if (err.length > 20000) err = err.slice(-10000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const meta = readJson(p.poolMeta);
      let count = meta && Number.isFinite(Number(meta.count)) ? Number(meta.count) : null;
      const m = /WROTE\s+\S+\s+(\d+)\s+videos/.exec(out);
      if (count == null && m) count = Number(m[1]);
      resolve({
        ok: code === 0 && count != null,
        code,
        count,
        tail: out.slice(-300),
        err: err.slice(-300),
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `无法启动 fetch_pool.py：${String((e && e.message) || e)}` });
    });
  });
}

/** 读现成视频池的条数 */
function poolCount() {
  const arr = readJson(paths().poolJson);
  return Array.isArray(arr) ? arr.length : 0;
}

async function statusPayload() {
  const p = paths();
  const st = readJson(p.stat);
  let running = childAlive();
  // 宽限期只给 15s：服务停掉后 status.json 还在，但 3 分钟（默认 180s）内都当"在跑"
  // 会让面板显示一堆早已关闭的窗口 → 用短宽限 + 探测兜底
  if (!running && statusFresh(st, 15000)) running = true;
  if (!running && st && Date.now() > probeCooldown) {
    // 服务可能是外部启动的（手动跑过 / 上次 DSH 会话留下的）：发一次 status 探测
    const probe = await sendCmd("status", undefined, 3000);
    running = !!(probe && probe.ok !== false && Number(probe.id) > 0);
    if (!running) probeCooldown = Date.now() + 20000;
  }
  const exe = resolveExe();
  const py = pythonExe();
  const exeExists = !!(exe.path && fs.existsSync(exe.path));
  const exeRunning = exeExists ? await probeExeRunning(exe.path) : false;
  const cfg = loadCfg();
  return {
    ok: true,
    version: VERSION,
    route: ROUTE,
    autoDir: p.auto,
    running,
    // 服务没跑时 status 里那份 windows 是上一次的残留快照，前端必须标注"已停止"
    status: st || null,
    stale: !running && !!st,
    deps: {
      scriptsOk: p.ok,
      scriptsDir: p.auto,
      scriptsHealed: p.healed,
      exe: exe.path || "",
      exeSource: exe.source,
      exeExists,
      exeRunning,
      python: py,
      pythonOk: pythonOk(py),
      autoLaunch: cfg.autoLaunch !== false,
    },
    poolCount: poolCount(),
  };
}

async function configPayload() {
  const p = paths();
  const exe = resolveExe();
  const py = pythonExe();
  const cfg = loadCfg();
  const exeExists = !!(exe.path && fs.existsSync(exe.path));
  const running = exeExists ? await probeExeRunning(exe.path) : false;
  return {
    ok: true,
    config: {
      exePath: cfg.exePath || "",
      autoDir: cfg.autoDir || "",
      pythonPath: cfg.pythonPath || "",
      autoLaunch: cfg.autoLaunch !== false,
    },
    detected: {
      autoDir: p.auto,
      autoDirOk: p.ok,
      autoDirHealed: p.healed,
      probed: p.probed,
      exe: exe.path || "",
      exeSource: exe.source,
      exeExists,
      exeRunning: running,
      python: py,
      pythonOk: pythonOk(py),
    },
    configFile: CFG_F,
  };
}

/** 版本号比较：1.0.10 > 1.0.9；忽略 -rc 之类的预发布后缀 */
function cmpVer(a, b) {
  const norm = (v) =>
    String(v || "0")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const x = norm(a);
  const y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

let _updCache = { at: 0, val: null };

/** 查上游最新版：国内镜像优先（官方 registry 在本机常超时） */
async function fetchLatestVersion(name) {
  const urls = [
    `https://registry.npmmirror.com/${encodeURIComponent(name)}/latest`,
    `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.version) {
        return { version: String(j.version), source: url.includes("npmmirror") ? "npmmirror" : "npm" };
      }
    } catch {
      /* 该源不可达，换下一个 */
    }
  }
  return null;
}

/**
 * 检查更新：三处版本对照（运行中 VERSION / 磁盘包 package.json / 上游 npm 最新版）。
 * 上游查不到不报错——本插件常以 link: 本地安装，本来就没有上游。
 */
async function checkUpdatePayload() {
  let packaged = "?";
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_F, "utf8"));
    packaged = (pkg && pkg.version) || "?";
  } catch {
    /* 读不到就留 "?" */
  }
  const base = { ok: true, current: VERSION, packaged };
  if (_updCache.val && Date.now() - _updCache.at < 300000) return { ...base, ..._updCache.val };

  let name = "dsh-piliaurora-wall";
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_F, "utf8"));
    if (pkg && pkg.name) name = pkg.name;
  } catch {
    /* ignore */
  }
  const up = await fetchLatestVersion(name);
  const val = up
    ? {
        latest: up.version,
        source: up.source,
        hasUpdate: cmpVer(up.version, VERSION) > 0,
        pendingRestart: cmpVer(packaged, VERSION) > 0,
        error: null,
      }
    : {
        latest: null,
        source: "none",
        hasUpdate: false,
        pendingRestart: cmpVer(packaged, VERSION) > 0,
        error: "上游查不到（本地链接安装属正常）",
      };
  _updCache = { at: Date.now(), val };
  return { ...base, ...val };
}

/** 弹系统文件选择框（异步：对话框在 powershell 子进程里，不冻结宿主） */
function pickExeDialog() {
  return new Promise((resolve) => {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$d = New-Object System.Windows.Forms.OpenFileDialog",
      "$d.Title = '选择 PiliAurora.exe（或 .lnk 快捷方式）'",
      "$d.Filter = '程序或快捷方式|*.exe;*.lnk|所有文件|*.*'",
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }",
    ].join("; ");
    let child;
    try {
      child = spawn("powershell", ["-NoProfile", "-STA", "-Command", ps], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    let out = "";
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: "选择对话框超时（120s）" });
    }, 120000);
    child.stdout.on("data", (b) => {
      out += b.toString("utf8");
    });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      const picked = lines.length ? lines[lines.length - 1].trim() : "";
      if (!picked) {
        finish({ ok: false, error: "未选择文件" });
        return;
      }
      const target = /\.lnk$/i.test(picked) ? readLnkSync(picked) : picked;
      finish({ ok: !!target, path: target || picked, lnk: /\.lnk$/i.test(picked) ? picked : "" });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: String((e && e.message) || e) });
    });
  });
}

// 顶层悬浮球已按用户要求下线（2026-11-18）：独立 OS 顶层窗口被嫌丑，
// 球入口回到 DSH 客户端 DOM（Ball 组件，可拖拽，位置存 localStorage）。

async function route(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  let sub = url.pathname;
  if (sub.startsWith(ROUTE)) sub = sub.slice(ROUTE.length) || "/";
  if (sub.length > 1 && sub.endsWith("/")) sub = sub.slice(0, -1);

  if (req.method === "GET" && (sub === "/status" || sub === "/health")) {
    json(res, await statusPayload());
    return;
  }

  // 供面板「检查更新」按钮对照：磁盘上插件包 package.json 的真实版本 vs 运行中 client VERSION
  if (req.method === "GET" && sub === "/version") {
    let packageVersion = "?";
    try {
      const pkg = JSON.parse(fs.readFileSync(PKG_F, "utf8"));
      packageVersion = (pkg && pkg.version) || "?";
    } catch {
      /* 读不到就用 "?"，前端会提示有更新 */
    }
    json(res, { ok: true, packageVersion: packageVersion, runningVersion: VERSION });
    return;
  }

  // 「检查更新」四态数据源：运行版本 / 磁盘包版本 / 上游最新版
  if (req.method === "GET" && sub === "/check-update") {
    json(res, await checkUpdatePayload());
    return;
  }

  if (req.method === "GET" && sub === "/config") {
    json(res, await configPayload());
    return;
  }

  if (req.method === "POST" && sub === "/config") {
    const b = await readBody(req);
    const patch = {};
    if (typeof b.exePath === "string") patch.exePath = b.exePath.trim();
    if (typeof b.autoDir === "string") patch.autoDir = b.autoDir.trim();
    if (typeof b.pythonPath === "string") patch.pythonPath = b.pythonPath.trim();
    if (typeof b.autoLaunch === "boolean") patch.autoLaunch = b.autoLaunch;
    saveCfg(patch);
    // 配置变了：清空所有探测缓存，下一次读取立即按新配置算
    _pathsCache = { at: 0, key: "", val: null };
    _pyCache = { at: 0, v: "" };
    _exeRun = { at: 0, exe: "", running: false, pid: 0 };
    json(res, await configPayload());
    return;
  }

  if (req.method === "POST" && sub === "/launch") {
    const b = await readBody(req);
    const exe = b.exePath ? { path: String(b.exePath) } : resolveExe();
    const r = await launchExe(exe.path);
    if (r.ok) {
      await sleep(4000);
      r.running = await probeExeRunning(exe.path);
    }
    json(res, { ...r, exe: exe.path || "" });
    return;
  }

  if (req.method === "POST" && sub === "/resolve-lnk") {
    const b = await readBody(req);
    const lnk = String(b.lnk || "").trim();
    const target = readLnkSync(lnk);
    json(res, {
      ok: !!target,
      lnk,
      target,
      error: target ? undefined : "解析失败：文件不存在或不是有效快捷方式",
    });
    return;
  }

  if (req.method === "POST" && sub === "/pick-exe") {
    json(res, await pickExeDialog());
    return;
  }

  // 打开外部链接：客户端 fetch 打不开系统浏览器，由宿主代开。
  // 白名单收紧到 https + github.com，避免这条通道被当成任意命令执行入口。
  if (req.method === "POST" && sub === "/open-url") {
    const b = await readBody(req);
    const url = String(b.url || "").trim();
    let allowed = false;
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      allowed = u.protocol === "https:" && (host === "github.com" || host.endsWith(".github.com"));
    } catch (e) {
      allowed = false;
    }
    if (!allowed) {
      json(res, { ok: false, error: "只允许打开 https://github.com 下的链接" }, 400);
      return;
    }
    const child = spawn("cmd", ["/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" });
    child.unref();
    json(res, { ok: true, url });
    return;
  }

  if (req.method === "POST" && sub === "/cmd") {
    const b = await readBody(req);
    const action = typeof b.action === "string" ? b.action : "";
    if (!action) {
      json(res, { ok: false, error: "缺少 action" }, 400);
      return;
    }
    // 换批/换单窗要重开播放进程（关旧窗 + 起新窗），实测单批 30~60s，必须放宽超时
    const SLOW = new Set(["next_batch", "next_one", "reload_pool", "stop"]);
    json(res, await sendCmd(action, b.value, SLOW.has(action) ? 120000 : 25000));
    return;
  }

  if (req.method === "POST" && sub === "/open") {
    const b = await readBody(req);
    // 窗口数 1..16（16 = 4x4；再多会挤爆屏幕且 PiliAurora 进程开销大）
    let count = Number(b.count);
    if (!Number.isFinite(count)) count = 8;
    count = Math.max(1, Math.min(16, Math.round(count)));
    const volume = Number.isFinite(Number(b.volume)) ? Math.max(0, Math.min(100, Number(b.volume))) : undefined;
    const keyword = typeof b.keyword === "string" ? b.keyword.trim() : "";
    const wantSearch = b.search === true;

    // 前置依赖检查 + 自动拉起 PiliAurora 主程序
    const ready = await ensureReady({ autoLaunch: b.launch !== false });
    if (ready.deps.blocking.length) {
      json(
        res,
        {
          ok: false,
          error: ready.deps.blocking[0].message,
          fix: ready.deps.blocking[0].fix,
          deps: ready.deps,
        },
        503,
      );
      return;
    }

    let fetched = null;
    if (wantSearch || keyword) {
      fetched = await runPool(keyword, Math.max(24, count * 6));
      // fetch_pool 退出码 3 = 该关键词 0 结果：区分"没搜到"和"抓取失败"，否则用户看不出来
      if (!fetched.ok) {
        const zero = fetched.code === 3;
        json(
          res,
          {
            ok: false,
            error: zero
              ? `关键词「${keyword || "(默认)"}」没搜到可用视频（换个词试试）`
              : `抓视频池失败：${(fetched.err || fetched.tail || "").trim() || "见 wall.log"}`,
            fetched,
            deps: ready.deps,
          },
          502,
        );
        return;
      }
      const now = poolCount();
      if (now < count) {
        // 池不够开窗：给出明确提示，不静默开重复窗口
        fetched = fetched || { ok: true, count: now };
        fetched.count = now;
        fetched.warn = `视频池只有 ${now} 条，${count} 个窗口会重复播放`;
      } else if (fetched && fetched.ok === false) {
        fetched.warn = `补抓视频池失败，继续用现有的 ${now} 条`;
      }
    }
    // 先快速探活（2.5s）；只有真活着才发 stop，避免服务已死时白等 25s
    const p = ready.p;
    const stBefore = readJson(p.stat);
    const probe = await sendCmd("status", undefined, 2500);
    const alive = !!(probe && probe.ok !== false);
    if (alive || childAlive()) {
      await sendCmd("stop", undefined, 25000);
      await sleep(2500);
    } else if (statusFresh(stBefore)) {
      // 服务已死但状态文件还新：直接把状态文件作废，免得面板继续显示旧窗口
      probeCooldown = Date.now() + 20000;
    }
    const started = startServer(count, volume);
    const st = await waitRunning(75000);
    // 开窗即开自动连播：每个窗口播完按视频时长自动换下一个（面板里可关）
    let autoplay = null;
    if (st && b.autoplay !== false) {
      autoplay = await sendCmd("autoplay", true, 15000);
    }
    json(res, {
      ok: !!st,
      count,
      volume,
      keyword,
      fetched,
      started,
      autoplay,
      deps: ready.deps,
      launched: ready.launched,
      status: st,
      error: st ? undefined : `服务已启动但窗口未在 75s 内就绪（看 ${p.log}）`,
    });
    return;
  }

  if (req.method === "POST" && (sub === "/stop" || sub === "/shutdown")) {
    const stopped = await sendCmd("stop", undefined, 8000);
    stopChild();
    json(res, { ok: true, stopped });
    return;
  }

  json(res, { ok: false, error: `未知路由 ${req.method} ${sub}` }, 404);
}

export function apply(ctx) {
  ctx.effect(() => {
    const off = ctx.webServer.register({
      kind: "prefix",
      path: ROUTE,
      handler: route,
    });
    // 启动预热：先把 路径 / 程序 / Python 的探测结果算进缓存，
    // 否则第一次打开设置页要现做 tasklist + 存在性探测，实测冷启动约 5s，
    // 期间客户端只能显示「检测中」，看起来像依赖全缺。
    const warm = setTimeout(() => {
      Promise.resolve()
        .then(() => {
          paths();
          pythonExe();
          resolveExe();
        })
        .then(() => configPayload())
        .catch(() => {
          /* 预热失败不影响正式请求 */
        });
    }, 1200);
    return () => {
      clearTimeout(warm);
      try {
        stopChild();
      } catch {
        /* ignore */
      }
      if (typeof off === "function") off();
    };
  });
}
