const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3101);
const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "db.json");
const backupDir = path.join(dataDir, "backups");
let stateCache = null;
let stateCacheMtime = 0;
let writeQueue = Promise.resolve();
const requestBuckets = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function ensureDataFile() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, "{}", "utf8");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local").split(",")[0].trim();
}

function rateLimited(req) {
  const now = Date.now();
  const key = clientIp(req);
  const bucket = requestBuckets.get(key) || { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60_000;
  }
  bucket.count += 1;
  requestBuckets.set(key, bucket);
  return bucket.count > 180;
}

function readState() {
  ensureDataFile();
  const stat = fs.statSync(dataFile);
  if (stateCache && stateCacheMtime === stat.mtimeMs) return structuredClone(stateCache);
  const state = JSON.parse(fs.readFileSync(dataFile, "utf8") || "{}");
  stateCache = state;
  stateCacheMtime = stat.mtimeMs;
  return structuredClone(state);
}

function writeState(state) {
  if (!state.meta) state.meta = {};
  state.meta.revision = Number(state.meta.revision || 0) + 1;
  state.meta.savedAt = new Date().toISOString();
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), "utf8");
  stateCache = state;
  stateCacheMtime = fs.statSync(dataFile).mtimeMs;
}

function withWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

function assertStateShape(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("无效的数据结构");
  const arrays = ["users", "roles", "assets", "plans", "inspections", "workOrders", "logs", "notifications", "auditLogs", "systemLogs"];
  arrays.forEach(name => {
    if (state[name] !== undefined && !Array.isArray(state[name])) throw new Error(`${name} 必须是数组`);
  });
  if (state.users?.some(user => !user || typeof user !== "object" || !user.role)) throw new Error("用户数据不完整");
  if (state.assets?.some(asset => !asset || typeof asset !== "object" || !asset.id || !asset.code || !asset.name)) throw new Error("资产数据不完整");
}

function mergeById(remoteItems = [], incomingItems = []) {
  const map = new Map();
  remoteItems.filter(item => item && item.id).forEach(item => map.set(item.id, item));
  incomingItems.filter(item => item && item.id).forEach(item => map.set(item.id, { ...map.get(item.id), ...item }));
  return [...map.values()];
}

function mergeStateForWrite(remote, incoming) {
  const merged = { ...remote, ...incoming };
  ["users", "roles", "auditLogs", "systemLogs"].forEach(name => {
    merged[name] = mergeById(remote[name], incoming[name]);
  });
  if (remote.meta) merged.meta = remote.meta;
  return merged;
}

function ensureModel(state) {
  if (!Array.isArray(state.roles)) {
    state.roles = [
      { id: "role-dba", name: "数据库管理员", code: "dba", permissions: ["*"] },
      { id: "role-admin", name: "资产管理员", code: "admin", permissions: ["asset:*", "inspection:*", "workorder:*", "report:*"] },
      { id: "role-inspector", name: "巡检员", code: "inspector", permissions: ["inspection:read", "inspection:write", "asset:read"] },
      { id: "role-worker", name: "维修人员", code: "worker", permissions: ["workorder:read", "workorder:write"] },
      { id: "role-reporter", name: "师生用户", code: "reporter", permissions: ["workorder:read", "workorder:confirm"] }
    ];
  }
  if (!Array.isArray(state.users)) state.users = [];
  state.users = state.users.map(user => ({
    username: user.username || user.role || "user",
    password: user.password || "123456",
    status: user.status || "enabled",
    roleId: user.roleId || `role-${user.role || "reporter"}`,
    ...user
  }));
  if (!state.users.some(user => user.username === "dbadmin")) {
    state.users.unshift({ id: "u-dba", name: "数据库管理员", username: "dbadmin", password: "dbadmin123", role: "dba", roleId: "role-dba", status: "enabled" });
  }
  if (!Array.isArray(state.auditLogs)) state.auditLogs = [];
  if (!Array.isArray(state.systemLogs)) state.systemLogs = [];
  if (!Array.isArray(state.assets)) state.assets = [];
  if (!Array.isArray(state.plans)) state.plans = [];
  if (!Array.isArray(state.inspections)) state.inspections = [];
  if (!Array.isArray(state.workOrders)) state.workOrders = [];
  if (!Array.isArray(state.logs)) state.logs = [];
  if (!Array.isArray(state.notifications)) state.notifications = [];
  if (!Array.isArray(state.templates)) state.templates = [];
  if (!state.settings) state.settings = { systemName: "校园资产巡检平台", notifyInApp: true, notifyEmail: false, notifySms: false, backupCycle: "daily" };
  if (!state.dictionaries) {
    state.dictionaries = {
      assetCategories: ["教学设备", "宿舍设施", "网络设备", "教学仪器"],
      assetStatuses: ["ACTIVE", "PENDING_INSPECTION", "MAINTENANCE", "RETIRED"],
      workOrderCategories: ["设备", "水电", "网络", "宿舍"],
      priorities: ["高", "中", "低"]
    };
  }
  if (!state.meta) state.meta = {};
  state.meta.storage = process.env.DATABASE_URL ? "postgresql-configured-json-fallback" : "json-file";
  return state;
}

function audit(state, action, target, detail) {
  ensureModel(state);
  state.auditLogs.unshift({ id: `audit-${Date.now().toString(36)}`, action, target, detail, time: new Date().toISOString() });
  state.auditLogs = state.auditLogs.slice(0, 300);
}

function collectionName(raw) {
  const aliases = {
    "work-orders": "workOrders",
    "audit-logs": "auditLogs",
    "system-logs": "systemLogs",
    "material-requests": "materialRequests",
    "problem-archive": "problemArchive"
  };
  return aliases[raw] || raw;
}

function csv(items) {
  const rows = Array.isArray(items) ? items : [];
  const headers = [...rows.reduce((set, item) => {
    Object.keys(item || {}).forEach(key => set.add(key));
    return set;
  }, new Set())];
  return [headers.join(","), ...rows.map(row => headers.map(key => JSON.stringify(row[key] ?? "")).join(","))].join("\n");
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!url.pathname.startsWith("/api/") || ["/api/state", "/api/health"].includes(url.pathname)) return false;

  if (url.pathname === "/api/docs") {
    sendJson(res, 200, {
      title: "Campus Asset Inspection REST API",
      endpoints: ["GET /api/:collection", "POST /api/:collection", "PUT /api/:collection/:id", "DELETE /api/:collection/:id", "GET /api/export?collection=assets&format=csv|json|pdf", "GET|POST /api/backups", "POST /api/restore", "GET /api/metrics"],
      storage: process.env.DATABASE_URL ? "DATABASE_URL 已配置，当前演示环境使用 JSON 回退存储" : "JSON 文件存储"
    });
    return true;
  }

  if (url.pathname === "/api/metrics") {
    const state = ensureModel(readState());
    sendJson(res, 200, {
      uptime: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      pid: process.pid,
      storage: state.meta.storage,
      counts: {
        users: state.users.length,
        roles: state.roles.length,
        assets: (state.assets || []).length,
        inspections: (state.inspections || []).length,
        workOrders: (state.workOrders || []).length,
        auditLogs: state.auditLogs.length
      }
    });
    return true;
  }

  if (url.pathname === "/api/export") {
    const state = ensureModel(readState());
    const name = collectionName(url.searchParams.get("collection") || "assets");
    const format = url.searchParams.get("format") || "json";
    const items = state[name] || [];
    if (format === "csv") {
      res.writeHead(200, { ...corsHeaders(), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` });
      res.end(csv(items));
      return true;
    }
    if (format === "pdf") {
      res.writeHead(200, { ...corsHeaders(), "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.html"` });
      res.end(`<!doctype html><meta charset="utf-8"><title>${name}</title><style>body{font-family:Arial,"Microsoft YaHei";padding:24px}pre{white-space:pre-wrap}</style><h1>${name} 导出报表</h1><pre>${JSON.stringify(items, null, 2)}</pre><script>window.print()</script>`);
      return true;
    }
    sendJson(res, 200, items);
    return true;
  }

  if (url.pathname === "/api/backups" && req.method === "GET") {
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    sendJson(res, 200, fs.readdirSync(backupDir).filter(file => file.endsWith(".json")).sort().reverse());
    return true;
  }

  if (url.pathname === "/api/backups" && req.method === "POST") {
    const state = ensureModel(readState());
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const file = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    audit(state, "backup.create", file, "手动创建数据备份");
    writeState(state);
    fs.copyFileSync(dataFile, path.join(backupDir, file));
    sendJson(res, 200, { ok: true, file });
    return true;
  }

  if (url.pathname === "/api/restore" && req.method === "POST") {
    const body = await readJson(req);
    const file = path.basename(body.file || "");
    const source = path.join(backupDir, file);
    if (!file || !fs.existsSync(source)) {
      sendJson(res, 404, { ok: false, message: "备份文件不存在" });
      return true;
    }
    fs.copyFileSync(source, dataFile);
    stateCache = null;
    const state = ensureModel(readState());
    audit(state, "backup.restore", file, "从备份恢复数据");
    writeState(state);
    sendJson(res, 200, { ok: true, file });
    return true;
  }

  const parts = url.pathname.replace(/^\/api\//, "").split("/");
  const name = collectionName(parts[0]);
  const id = parts[1] ? decodeURIComponent(parts[1]) : "";
  if (!name) return false;

  if (req.method === "GET") {
    const state = ensureModel(readState());
    const items = state[name] || [];
    sendJson(res, 200, id ? items.find(item => item.id === id || item.code === id) || null : items);
    return true;
  }

  if (["POST", "PUT", "DELETE"].includes(req.method)) {
    await withWrite(async () => {
      const state = ensureModel(readState());
      if (!Array.isArray(state[name])) state[name] = [];
      if (req.method === "POST") {
        const item = await readJson(req);
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("无效的请求数据");
        if (!item.id) item.id = `${name}-${Date.now().toString(36)}`;
        state[name].unshift(item);
        audit(state, `${name}.create`, item.id, "新增记录");
        writeState(state);
        sendJson(res, 201, item);
        return;
      }
      const index = state[name].findIndex(item => item.id === id || item.code === id);
      if (index < 0) {
        sendJson(res, 404, { ok: false, message: "记录不存在" });
        return;
      }
      if (req.method === "PUT") {
        const patch = await readJson(req);
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("无效的请求数据");
        state[name][index] = { ...state[name][index], ...patch, updatedAt: new Date().toISOString() };
        audit(state, `${name}.update`, id, "更新记录");
        writeState(state);
        sendJson(res, 200, state[name][index]);
        return;
      }
      const removed = state[name].splice(index, 1)[0];
      audit(state, `${name}.delete`, id, "删除记录");
      writeState(state);
      sendJson(res, 200, removed);
    });
    return true;
  }

  return false;
}

function serveStatic(req, res) {
  const requestPath = decodeURIComponent(req.url.split("?")[0]);
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, corsHeaders());
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
  if (error) {
      res.writeHead(404, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { ...corsHeaders(), "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

ensureDataFile();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (rateLimited(req)) {
      sendJson(res, 429, { ok: false, message: "请求过于频繁，请稍后再试" });
      return;
    }
    if (req.url === "/api/health") {
      sendJson(res, 200, { ok: true, project: "campus-asset-inspection" });
      return;
    }
    if (req.url === "/api/state" && req.method === "GET") {
      sendJson(res, 200, ensureModel(readState()));
      return;
    }
    if (req.url === "/api/state" && req.method === "POST") {
      await withWrite(async () => {
        const incoming = await readJson(req);
        assertStateShape(incoming);
        ensureModel(incoming);
        const current = ensureModel(readState());
        const merged = mergeStateForWrite(current, incoming);
        ensureModel(merged);
        writeState(merged);
        sendJson(res, 200, { ok: true, savedAt: new Date().toISOString(), revision: merged.meta.revision });
      });
      return;
    }
    if (await handleApi(req, res)) return;
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, message: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Campus Asset Inspection is running at http://localhost:${PORT}`);
});
