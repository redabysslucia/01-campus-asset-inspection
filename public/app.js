const STORAGE_VERSION = "asset-inspection-v1";

const roleMap = {
  admin: { name: "资产管理员", desc: "资产入库、受理异常、派单与报废处置" },
  inspector: { name: "巡检员", desc: "执行巡检计划，提交正常或异常记录" },
  worker: { name: "维修人员", desc: "接收维修任务，开始处理并提交结果" },
  reporter: { name: "师生用户", desc: "直接报修、查看工单、确认完成或反馈未解决" },
  dba: { name: "数据库管理员", desc: "用户角色管理、数据备份恢复、审计与系统配置" }
};

const statusMap = {
  ACTIVE: ["正常", "ok"],
  PENDING_INSPECTION: ["待巡检", "warn"],
  MAINTENANCE: ["维修中", "danger"],
  RETIRED: ["已报废", "dark"],
  PENDING_ACCEPT: ["待受理", "warn"],
  PENDING_ASSIGN: ["待派单", "warn"],
  PENDING_PROCESS: ["待处理", "warn"],
  PROCESSING: ["处理中", "danger"],
  PENDING_CONFIRM: ["待确认", "warn"],
  DONE: ["已完成", "ok"],
  CANCELLED: ["已取消", "dark"],
  FEEDBACK: ["反馈未解决", "danger"]
};

let currentRole = null;
let activeView = "dashboard";
let state = null;
let lastSyncedState = null;
let isSaving = false;

const $ = selector => document.querySelector(selector);
const app = $("#app");
const assetLoginKey = "campus-asset-auth-user";

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function mergeCollection(remoteItems = [], localItems = [], baseItems = []) {
  const remoteById = new Map(remoteItems.filter(item => item && item.id).map(item => [item.id, item]));
  const localById = new Map(localItems.filter(item => item && item.id).map(item => [item.id, item]));
  const baseById = new Map(baseItems.filter(item => item && item.id).map(item => [item.id, item]));
  const ids = new Set([...remoteById.keys(), ...localById.keys(), ...baseById.keys()]);

  return [...ids].map(id => {
    const remote = remoteById.get(id);
    const local = localById.get(id);
    const base = baseById.get(id);
    if (!local) return remote;
    if (!base) return local;
    if (!remote) return sameJson(local, base) ? undefined : local;
    return sameJson(local, base) ? remote : local;
  }).filter(Boolean);
}

function mergeState(remote, local, base) {
  const merged = { ...remote, ...local };
  const collections = ["users", "roles", "assets", "plans", "inspections", "workOrders", "logs", "notifications", "auditLogs", "systemLogs", "templates"];
  collections.forEach(name => {
    merged[name] = mergeCollection(remote?.[name], local?.[name], base?.[name]);
  });
  if (remote?.meta) merged.meta = remote.meta;
  return merged;
}

function showBusy(show) {
  isSaving = Boolean(show);
  let node = document.querySelector(".app-saving");
  if (!node) {
    node = document.createElement("div");
    node.className = "app-saving";
    node.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:9999;padding:10px 14px;border-radius:8px;background:#111827;color:#fff;box-shadow:0 10px 25px rgba(0,0,0,.18);font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s";
    node.textContent = "正在保存...";
    document.body.appendChild(node);
  }
  node.style.opacity = show ? "1" : "0";
}

function currentLoginSession() {
  try {
    return JSON.parse(localStorage.getItem(assetLoginKey) || "null");
  } catch (error) {
    return null;
  }
}

function currentUserName(role = currentRole) {
  const session = currentLoginSession();
  const sessionUser = state?.users?.find(item => item.username === session?.username && item.status !== "disabled");
  const fallbackUser = state?.users?.find(item => item.role === role && item.status !== "disabled");
  const user = sessionUser || fallbackUser;
  return user?.name || roleMap[role]?.name || "当前用户";
}

function enabledUsers(role) {
  return (state?.users || []).filter(item => item.role === role && item.status !== "disabled");
}

function defaultWorkerName() {
  const worker = enabledUsers("worker")[0];
  return worker?.name || "维修人员";
}

function canCurrentWorkerHandle(order) {
  return currentRole === "worker" && (!order.handler || order.handler === currentUserName("worker"));
}

function userOptions(role, selectedName = "") {
  const users = enabledUsers(role);
  if (!users.length) return `<option value="${roleMap[role]?.name || "未分配"}">${roleMap[role]?.name || "未分配"}</option>`;
  return users.map(user => `<option value="${user.name}" ${user.name === selectedName ? "selected" : ""}>${user.name}</option>`).join("");
}

function defaultState() {
  return {
    version: STORAGE_VERSION,
    users: [
      { id: "u-admin", name: "陈老师", role: "admin" },
      { id: "u-inspector", name: "李巡检", role: "inspector" },
      { id: "u-worker", name: "王维修", role: "worker" },
      { id: "u-reporter", name: "张同学", role: "reporter" }
    ],
    assets: [
      { id: "a-101", code: "AS-2026-001", name: "多媒体中控台", category: "教学仪器", model: "EduBox X3", location: "笃行楼-301", status: "ACTIVE", purchaseDate: "2024-09-01", warrantyEnd: "2027-09-01", owner: "教务处", qr: "AS-2026-001" },
      { id: "a-102", code: "AS-2026-002", name: "宿舍空调", category: "宿舍设施", model: "KFR-35GW", location: "5号宿舍-418", status: "PENDING_INSPECTION", purchaseDate: "2023-06-12", warrantyEnd: "2026-06-12", owner: "后勤处", qr: "AS-2026-002" },
      { id: "a-103", code: "AS-2026-003", name: "核心交换机", category: "网络设备", model: "S5720", location: "信息中心-机房", status: "MAINTENANCE", purchaseDate: "2022-03-18", warrantyEnd: "2027-03-18", owner: "信息中心", qr: "AS-2026-003" },
      { id: "a-104", code: "AS-2026-004", name: "实验室投影仪", category: "教室设备", model: "PX701", location: "实验楼-B206", status: "ACTIVE", purchaseDate: "2025-01-10", warrantyEnd: "2028-01-10", owner: "实验中心", qr: "AS-2026-004" }
    ],
    plans: [
      { id: "p-1", assetId: "a-101", cycle: "每周", inspector: "李巡检", nextDate: "2026-07-08" },
      { id: "p-2", assetId: "a-102", cycle: "每日", inspector: "李巡检", nextDate: "2026-07-06" },
      { id: "p-3", assetId: "a-104", cycle: "每月", inspector: "李巡检", nextDate: "2026-07-20" }
    ],
    inspections: [
      { id: "r-1", assetId: "a-101", inspector: "李巡检", result: "NORMAL", description: "运行正常，线缆固定良好。", conductedAt: "2026-07-05 09:20", workOrderId: null },
      { id: "r-2", assetId: "a-103", inspector: "李巡检", result: "ABNORMAL", description: "机柜温度偏高，交换机告警灯闪烁。", conductedAt: "2026-07-05 15:40", workOrderId: "wo-1" }
    ],
    workOrders: [
      { id: "wo-1", code: "WO-20260705-001", assetId: "a-103", title: "核心交换机异常告警", description: "巡检发现机柜温度偏高，交换机告警灯闪烁。", status: "PROCESSING", reporter: "系统巡检", handler: "王维修", result: "", createdAt: "2026-07-05 15:40", updatedAt: "2026-07-05 16:10" }
    ],
    logs: [
      { id: "l-1", target: "AS-2026-003", content: "异常巡检自动生成工单 WO-20260705-001", time: "2026-07-05 15:40" },
      { id: "l-2", target: "WO-20260705-001", content: "管理员派单给王维修，工单进入处理中", time: "2026-07-05 16:10" }
    ],
    notifications: [
      { id: "n-1", title: "核心交换机维修中", content: "WO-20260705-001 已由王维修处理", time: "2026-07-05 16:10" }
    ]
  };
}

async function loadState() {
  try {
    const res = await fetch("/api/state");
    const remote = await res.json();
    state = remote && remote.version === STORAGE_VERSION ? remote : defaultState();
    lastSyncedState = clone(state);
    if (!remote.version) await saveState();
  } catch (error) {
    state = defaultState();
    lastSyncedState = clone(state);
  }
}

async function saveState() {
  showBusy(true);
  try {
    const latestRes = await fetch("/api/state");
    if (!latestRes.ok) throw new Error("读取服务器最新数据失败");
    const latest = await latestRes.json();
    const merged = mergeState(latest, state, lastSyncedState);
    const saveRes = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(merged)
    });
    if (!saveRes.ok) throw new Error("保存失败");
    state = merged;
    lastSyncedState = clone(merged);
  } catch (error) {
    alert(`保存失败：${error.message}`);
    throw error;
  } finally {
    showBusy(false);
  }
}

function tag(status) {
  const [text, cls] = statusMap[status] || [status, "dark"];
  return `<span class="tag ${cls}">${text}</span>`;
}

function assetName(assetId) {
  const asset = state.assets.find(item => item.id === assetId);
  return asset ? `${asset.name}（${asset.code}）` : "未知资产";
}

function addLog(target, content) {
  state.logs.unshift({ id: uid("log"), target, content, time: nowText() });
}

function notify(title, content) {
  state.notifications.unshift({ id: uid("notice"), title, content, time: nowText() });
}

function countBy(list, field) {
  return list.reduce((acc, item) => {
    acc[item[field]] = (acc[item[field]] || 0) + 1;
    return acc;
  }, {});
}

/* ---- 角色数据隔离 ---- */
function myWorkOrders() {
  const list = Array.isArray(state?.workOrders) ? state.workOrders : [];
  if (!list.length) return [];
  if (currentRole === "admin") return list;
  const myName = currentUserName();
  if (currentRole === "inspector") {
    const inspList = Array.isArray(state?.inspections) ? state.inspections : [];
    const myOrderIds = new Set(inspList.filter(r => r.inspector === myName).map(r => r.workOrderId).filter(Boolean));
    return list.filter(o => myOrderIds.has(o.id));
  }
  if (currentRole === "worker") {
    return list.filter(o => o.handler === myName || (o.status === "PENDING_PROCESS" && !o.handler));
  }
  if (currentRole === "reporter") {
    return list.filter(o => o.reporter === myName);
  }
  return list;
}

function myInspections() {
  const list = Array.isArray(state?.inspections) ? state.inspections : [];
  if (!list.length) return [];
  if (currentRole === "admin") return list;
  if (currentRole === "inspector") return list.filter(r => r.inspector === currentUserName());
  const myOrders = myWorkOrders();
  const myAssetIds = new Set(myOrders.map(o => o.assetId));
  return list.filter(r => myAssetIds.has(r.assetId));
}

function myLogs() {
  const list = Array.isArray(state?.logs) ? state.logs : [];
  if (!list.length) return [];
  if (currentRole === "admin") return list;
  const myOrders = myWorkOrders();
  const relevant = new Set();
  myOrders.forEach(o => { relevant.add(o.code); relevant.add(o.assetId); });
  const inspList = Array.isArray(state?.inspections) ? state.inspections : [];
  inspList.filter(r => r.inspector === currentUserName()).forEach(r => relevant.add(r.id));
  return list.filter(log => [...relevant].some(code => log.target === code || (log.content || "").includes(code)));
}

function loginScreen() {
  app.innerHTML = `
    <main class="login-shell">
      <section class="hero">
        <div class="hero-mark">巡</div>
        <h1>校园资产智慧巡检与全生命周期管理平台</h1>
        <p>围绕实践周要求完成资产登记、巡检计划、异常上报、维修工单、状态更新和报废处置。系统覆盖管理员、巡检员、维修人员、师生用户四类角色，可现场演示完整闭环。</p>
        <div class="hero-flow">
          ${["资产入库", "巡检计划", "执行巡检", "异常工单", "维修处理", "确认归档"].map(text => `<span class="flow-pill">${text}</span>`).join("")}
        </div>
      </section>
      <section class="login-panel">
        <h2>选择演示角色</h2>
        <p>答辩时按角色切换，演示“谁能做什么动作”。</p>
        <div class="role-list">
          ${Object.entries(roleMap).map(([key, item]) => `
            <button class="role-card" data-login="${key}">
              <strong>${item.name}</strong>
              <span>${item.desc}</span>
            </button>
          `).join("")}
        </div>
      </section>
    </main>
  `;
  document.querySelectorAll("[data-login]").forEach(btn => {
    btn.addEventListener("click", () => {
      currentRole = btn.dataset.login;
      if (currentRole === "dba") {
        if (typeof window.openDbaPanel === "function") window.openDbaPanel();
        else alert("数据库管理员模块加载失败，请刷新页面。");
        return;
      }
      activeView = "dashboard";
      render();
    });
  });
}

function shell(content) {
  const navs = [
    ["dashboard", "数据看板", "●"],
    ["assets", "资产管理", "◆"],
    ["inspection", "巡检执行", "▲"],
    ["orders", "维修工单", "■"],
    ["logs", "日志通知", "●"]
  ];
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-badge">巡</div>
          <div>
            <div class="brand-title">资产巡检平台</div>
            <div class="brand-sub">Practice Week Project 01</div>
          </div>
        </div>
        <nav class="nav">
          ${navs.map(([key, label, icon]) => `<button class="${activeView === key ? "active" : ""}" data-nav="${key}"><span>${label}</span><span>${icon}</span></button>`).join("")}
        </nav>
        <div class="sidebar-footer">
          课程要求：三类以上角色、完整工单闭环、数据持久化、README 与演示账号。
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div>
            <h2>${roleMap[currentRole].name}</h2>
            <p>${roleMap[currentRole].desc}</p>
          </div>
          <div class="user-box">
            <div class="avatar">${roleMap[currentRole].name.slice(0, 1)}</div>
            <button class="ghost" id="logoutBtn">退出</button>
          </div>
        </header>
        ${content}
      </main>
    </div>
  `;
  document.querySelectorAll("[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => {
      activeView = btn.dataset.nav;
      render();
    });
  });
  $("#logoutBtn").addEventListener("click", () => {
    currentRole = null;
    loginScreen();
  });
}

function dashboardView() {
  const statusCounts = countBy(state.assets, "status");
  const categoryCounts = countBy(state.assets, "category");
  const abnormal = myInspections().filter(item => item.result === "ABNORMAL").length;
  const done = myWorkOrders().filter(item => item.status === "DONE").length;
  const maxCategory = Math.max(...Object.values(categoryCounts), 1);
  const now = new Date();
  const warningDate = new Date(now.getTime() + 30 * 86400000);
  const expiredAssets = state.assets.filter(a => a.warrantyEnd && new Date(a.warrantyEnd) < now && a.status !== "RETIRED");
  const expiringAssets = state.assets.filter(a => a.warrantyEnd && new Date(a.warrantyEnd) >= now && new Date(a.warrantyEnd) <= warningDate && a.status !== "RETIRED");
  const todayStr = today();
  const overduePlans = state.plans.filter(p => p.nextDate && p.nextDate < todayStr);
  const openOrders = myWorkOrders().filter(o => !["DONE", "CANCELLED"].includes(o.status)).length;
  const coverage = state.assets.length ? Math.round((new Set(state.inspections.map(r => r.assetId)).size / state.assets.length) * 100) : 0;
  shell(`
    <section class="grid kpi-grid">
      <div class="panel kpi"><div><small>资产总数</small><strong>${state.assets.length}</strong></div><div class="spark">资</div></div>
      <div class="panel kpi"><div><small>待巡检</small><strong>${statusCounts.PENDING_INSPECTION || 0}</strong></div><div class="spark">检</div></div>
      <div class="panel kpi"><div><small>异常记录</small><strong>${abnormal}</strong></div><div class="spark">异</div></div>
      <div class="panel kpi"><div><small>完成工单</small><strong>${done}</strong></div><div class="spark">闭</div></div>
      <div class="panel kpi"><div><small>未结工单</small><strong style="color:${openOrders > 0 ? '#dc2626' : 'inherit'}">${openOrders}</strong></div><div class="spark">修</div></div>
      <div class="panel kpi"><div><small>巡检覆盖率</small><strong>${coverage}%</strong></div><div class="spark">覆</div></div>
      <div class="panel kpi"><div><small>到期巡检</small><strong style="color:${overduePlans.length > 0 ? '#dc2626' : 'inherit'}">${overduePlans.length}</strong></div><div class="spark">期</div></div>
      <div class="panel kpi"><div><small>保修预警</small><strong style="color:${(expiredAssets.length + expiringAssets.length) > 0 ? '#d97706' : 'inherit'}">${expiredAssets.length + expiringAssets.length}</strong></div><div class="spark">保</div></div>
    </section>
    ${(expiredAssets.length + expiringAssets.length) > 0 ? `
    <section class="panel" style="margin-top:16px">
      <h3>⚠ 保修到期预警</h3>
      <div class="db-table-wrap"><table>
        <thead><tr><th>资产编号</th><th>名称</th><th>保修到期</th><th>状态</th><th>位置</th></tr></thead>
        <tbody>
          ${[...expiredAssets, ...expiringAssets].map(a => `
            <tr class="${new Date(a.warrantyEnd) < now ? 'row-expired' : 'row-expiring'}">
              <td><strong>${a.code}</strong></td><td>${a.name}</td>
              <td><span class="tag ${new Date(a.warrantyEnd) < now ? 'danger' : 'warn'}">${a.warrantyEnd}</span></td>
              <td>${tag(a.status)}</td><td>${a.location}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>
    </section>` : ""}
    ${overduePlans.length > 0 ? `
    <section class="panel" style="margin-top:16px">
      <h3>⚠ 到期未巡检</h3>
      <div class="db-table-wrap"><table>
        <thead><tr><th>资产</th><th>周期</th><th>巡检员</th><th>应巡检日期</th></tr></thead>
        <tbody>${overduePlans.map(p => `<tr><td>${assetName(p.assetId)}</td><td>${p.cycle}</td><td>${p.inspector}</td><td><span class="tag danger">${p.nextDate}</span></td></tr>`).join("")}</tbody>
      </table></div>
    </section>` : ""}
    <section class="grid two-col" style="margin-top:16px">
      <div class="panel">
        <h3>资产分类分布</h3>
        ${Object.entries(categoryCounts).map(([name, value]) => `
          <div class="bar-row"><span>${name}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(12, value / maxCategory * 100)}%"></div></div><strong>${value}</strong></div>
        `).join("")}
      </div>
      <div class="panel">
        <h3>状态总览</h3>
        <div class="status-strip">
          ${["ACTIVE", "PENDING_INSPECTION", "MAINTENANCE", "RETIRED"].map(key => `
            <div class="status-item"><span>${tag(key)}</span><strong>${statusCounts[key] || 0}</strong></div>
          `).join("")}
        </div>
      </div>
    </section>
    <section class="panel" style="margin-top:16px">
      <h3>业务闭环演示路径</h3>
      <div class="hero-flow">
        ${["管理员新增资产", "巡检员提交异常", "系统自动生成工单", "管理员受理派单", "维修人员处理", "师生确认完成"].map(text => `<span class="flow-pill">${text}</span>`).join("")}
      </div>
    </section>
  `);
}

let assetSearchKeyword = "";
let assetFilterStatus = "";

function assetsView() {
  const filtered = state.assets.filter(asset => {
    const kw = assetSearchKeyword.toLowerCase();
    const matched = !kw || [asset.code, asset.name, asset.category, asset.location, asset.owner, asset.model].some(v => String(v || "").toLowerCase().includes(kw));
    const statusMatch = !assetFilterStatus || asset.status === assetFilterStatus;
    return matched && statusMatch;
  });
  const statuses = [...new Set(state.assets.map(a => a.status))];
  const warningDays = 30;
  const now = new Date();
  const warningDate = new Date(now.getTime() + warningDays * 86400000);
  shell(`
    <section class="grid two-col">
      <div class="panel"${currentRole !== "admin" ? ` style="grid-column:1 / -1"` : ""}>
        <h3>资产台账 <span class="meta">共 ${state.assets.length} 条，显示 ${filtered.length} 条</span></h3>
        <div class="filter-bar">
          <input id="assetSearch" placeholder="搜索编号、名称、分类、位置..." value="${assetSearchKeyword.replace(/"/g, "&quot;")}" />
          <select id="assetStatusFilter"><option value="">全部状态</option>${statuses.map(s => `<option value="${s}" ${assetFilterStatus === s ? "selected" : ""}>${(statusMap[s] || [s])[0]}</option>`).join("")}</select>
          <button class="ghost" id="assetSearchBtn">搜索</button>
          ${currentRole === "admin" ? `<button class="ghost" id="assetClearFilterBtn">清除</button>` : ""}
        </div>
        <div class="db-table-wrap"><table>
          <thead><tr><th>编号/名称</th><th>分类</th><th>位置</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            ${filtered.map(asset => {
              const expiry = asset.warrantyEnd ? new Date(asset.warrantyEnd) : null;
              const isExpiring = expiry && expiry <= warningDate && asset.status !== "RETIRED";
              const isExpired = expiry && expiry < now && asset.status !== "RETIRED";
              return `
              <tr class="${isExpired ? "row-expired" : isExpiring ? "row-expiring" : ""}">
                <td>
                  <strong>${asset.code}</strong><br><span class="meta">${asset.name} · ${asset.model}</span>
                  ${isExpired ? `<span class="tag danger" style="margin-top:4px">保修已过期</span>` : isExpiring ? `<span class="tag warn" style="margin-top:4px">即将过期</span>` : ""}
                </td>
                <td>${asset.category}</td>
                <td>${asset.location}<br><span class="meta">${asset.owner}</span></td>
                <td>${tag(asset.status)}</td>
                <td class="actions">
                  <button class="ghost" data-asset-detail="${asset.id}">详情</button>
                  ${currentRole === "admin" ? `<button class="ghost" data-asset-edit="${asset.id}">编辑</button>` : ""}
                  ${currentRole === "admin" && asset.status !== "RETIRED" ? `<button class="danger" data-asset-retire="${asset.id}">报废</button>` : ""}
                  ${currentRole === "admin" ? `<button class="danger" data-asset-delete="${asset.id}">删除</button>` : ""}
                </td>
              </tr>`;
            }).join("")}
            ${filtered.length === 0 ? `<tr><td colspan="5" class="empty">暂无匹配的资产记录</td></tr>` : ""}
          </tbody>
        </table></div>
      </div>
      ${currentRole === "admin" ? `
      <div class="panel">
        <h3>${state._editingAsset ? "编辑资产" : "资产入库"}</h3>
        <form class="form" id="assetForm">
          ${state._editingAsset ? `<input type="hidden" name="editId" value="${state._editingAsset}" />` : ""}
          <label>资产名称<input name="name" required placeholder="如：实验室交换机" value="${(state._editingAsset ? (state.assets.find(a => a.id === state._editingAsset) || {}).name : "").replace(/"/g, "&quot;")}" /></label>
          <div class="form-row">
            <label>分类<select name="category">${["教室设备","宿舍设施","网络设备","教学仪器"].map(c => `<option ${state._editingAsset && (state.assets.find(a => a.id === state._editingAsset) || {}).category === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
            <label>型号<input name="model" placeholder="设备型号" value="${(state._editingAsset ? (state.assets.find(a => a.id === state._editingAsset) || {}).model || "" : "").replace(/"/g, "&quot;")}" /></label>
          </div>
          <label>位置<input name="location" required placeholder="楼栋-房间" value="${(state._editingAsset ? (state.assets.find(a => a.id === state._editingAsset) || {}).location || "" : "").replace(/"/g, "&quot;")}" /></label>
          <div class="form-row">
            <label>购置日期<input name="purchaseDate" type="date" value="${state._editingAsset ? (state.assets.find(a => a.id === state._editingAsset) || {}).purchaseDate || today() : today()}" /></label>
            <label>保修到期<input name="warrantyEnd" type="date" value="${state._editingAsset ? (state.assets.find(a => a.id === state._editingAsset) || {}).warrantyEnd || "2028-07-06" : "2028-07-06"}" /></label>
          </div>
          <label>巡检周期<select name="cycle"><option>每日</option><option selected>每周</option><option>每两周</option><option>每月</option><option>每季度</option></select></label>
          <label>巡检员<select name="inspector">${userOptions("inspector", currentUserName("inspector"))}</select></label>
          <div class="actions">
            <button class="primary">${state._editingAsset ? "保存修改" : "新增资产"}</button>
            ${state._editingAsset ? `<button class="ghost" type="button" id="cancelEditBtn">取消编辑</button>` : ""}
          </div>
        </form>
      </div>` : ""}
    </section>
  `);
  const searchInput = $("#assetSearch");
  const searchBtn = $("#assetSearchBtn");
  if (searchInput) {
    searchInput.addEventListener("keydown", e => { if (e.key === "Enter") { assetSearchKeyword = searchInput.value; assetFilterStatus = $("#assetStatusFilter")?.value || ""; render(); } });
  }
  if (searchBtn) searchBtn.addEventListener("click", () => { assetSearchKeyword = searchInput?.value || ""; assetFilterStatus = $("#assetStatusFilter")?.value || ""; render(); });
  const clearBtn = $("#assetClearFilterBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => { assetSearchKeyword = ""; assetFilterStatus = ""; render(); });
  const cancelBtn = $("#cancelEditBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", () => { delete state._editingAsset; render(); });
  document.querySelectorAll("[data-asset-detail]").forEach(btn => {
    btn.addEventListener("click", () => showAssetDetail(btn.dataset.assetDetail));
  });
  document.querySelectorAll("[data-asset-edit]").forEach(btn => {
    btn.addEventListener("click", () => { state._editingAsset = btn.dataset.assetEdit; render(); });
  });
  document.querySelectorAll("[data-asset-retire]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认将该资产标记为已报废？此操作不可撤销。")) return;
      const asset = state.assets.find(a => a.id === btn.dataset.assetRetire);
      if (asset) {
        asset.status = "RETIRED"; asset.updatedAt = nowText();
        const activeOrders = state.workOrders.filter(o => o.assetId === asset.id && !["DONE", "CANCELLED"].includes(o.status));
        activeOrders.forEach(o => { o.status = "CANCELLED"; o.updatedAt = nowText(); });
        addLog(asset.code, `资产已报废处置${activeOrders.length ? "，关联 " + activeOrders.length + " 个工单已自动取消" : ""}`);
        notify("资产报废", `${asset.name}（${asset.code}）已报废`);
        await saveState(); render();
      }
    });
  });
  document.querySelectorAll("[data-asset-delete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认删除该资产及其关联的巡检计划和记录？此操作不可撤销。")) return;
      const id = btn.dataset.assetDelete;
      const asset = state.assets.find(a => a.id === id);
      state.assets = state.assets.filter(a => a.id !== id);
      state.plans = state.plans.filter(p => p.assetId !== id);
      state.inspections = state.inspections.filter(r => r.assetId !== id);
      state.workOrders = state.workOrders.filter(o => o.assetId !== id);
      if (asset) { addLog(asset.code, `资产 ${asset.name} 已删除（含关联工单）`); notify("资产删除", `${asset.name} 已从系统中移除`); }
      await saveState(); render();
    });
  });
  const form = $("#assetForm");
  if (form) form.addEventListener("submit", async event => {
    event.preventDefault();
    if (currentRole !== "admin") return alert("只有资产管理员可以操作资产");
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (data.editId) {
      const asset = state.assets.find(a => a.id === data.editId);
      if (asset) {
        Object.assign(asset, { name: data.name, category: data.category, model: data.model || "-", location: data.location, purchaseDate: data.purchaseDate, warrantyEnd: data.warrantyEnd, updatedAt: nowText() });
        const plan = state.plans.find(p => p.assetId === asset.id);
        if (plan) { plan.cycle = data.cycle; plan.inspector = data.inspector || currentUserName("inspector"); }
        addLog(asset.code, `资产 ${data.name} 信息已更新`);
        notify("资产更新", `${data.name} 信息已更新`);
        delete state._editingAsset;
      }
    } else {
      const code = `AS-${new Date().getFullYear()}-${String(state.assets.length + 1).padStart(3, "0")}`;
      const owner = currentUserName("admin");
      state.assets.unshift({ id: uid("asset"), code, name: data.name, category: data.category, model: data.model || "-", location: data.location, status: "PENDING_INSPECTION", purchaseDate: data.purchaseDate, warrantyEnd: data.warrantyEnd, owner, qr: code });
      state.plans.unshift({ id: uid("plan"), assetId: state.assets[0].id, cycle: data.cycle || "每周", inspector: data.inspector || currentUserName("inspector"), nextDate: today() });
      addLog(code, `资产 ${data.name} 入库并生成巡检计划（${data.cycle || "每周"}）`);
      notify("资产入库", `${data.name} 已进入待巡检队列`);
    }
    await saveState();
    render();
  });
}

function inspectionView() {
  const todayStr = today();
  const overduePlans = state.plans.filter(p => p.nextDate && p.nextDate < todayStr);
  shell(`
    <section class="grid two-col">
      <div class="panel"${currentRole !== "inspector" ? ` style="grid-column:1 / -1"` : ""}>
        <h3>巡检计划 <span class="meta">共 ${state.plans.length} 条${overduePlans.length ? `，<span style="color:#dc2626">${overduePlans.length} 条已到期</span>` : ""}</span></h3>
        <div class="cards">
          ${state.plans.map(plan => {
            const isOverdue = plan.nextDate && plan.nextDate < todayStr;
            return `
            <article class="card ${isOverdue ? "card-overdue" : ""}">
              <h4>${assetName(plan.assetId)} ${isOverdue ? `<span class="tag danger">已到期</span>` : ""}</h4>
              <div class="meta">周期：${plan.cycle}<br>负责人：${plan.inspector}<br>下次巡检：${plan.nextDate}</div>
              ${currentRole === "admin" ? `<div class="actions"><button class="ghost" data-plan-edit="${plan.id}">编辑</button><button class="danger" data-plan-delete="${plan.id}">删除</button></div>` : ""}
            </article>`;
          }).join("")}
          ${state.plans.length === 0 ? `<div class="empty">暂无巡检计划</div>` : ""}
        </div>
        ${currentRole === "admin" ? `
        <div class="panel" style="margin-top:14px">
          <h3>${state._editingPlan ? "编辑巡检计划" : "新建巡检计划"}</h3>
          <form class="form" id="planForm">
            ${state._editingPlan ? `<input type="hidden" name="planEditId" value="${state._editingPlan}" />` : ""}
            <label>资产<select name="planAssetId">${state.assets.map(a => `<option value="${a.id}" ${state._editingPlan && (state.plans.find(p => p.id === state._editingPlan) || {}).assetId === a.id ? "selected" : ""}>${a.code} - ${a.name}</option>`).join("")}</select></label>
            <div class="form-row">
              <label>巡检周期<select name="planCycle"><option>每日</option><option selected>每周</option><option>每两周</option><option>每月</option><option>每季度</option></select></label>
              <label>下次巡检日期<input name="planNextDate" type="date" value="${state._editingPlan ? (state.plans.find(p => p.id === state._editingPlan) || {}).nextDate || todayStr : todayStr}" /></label>
            </div>
            <label>巡检员<select name="planInspector">${userOptions("inspector", currentUserName("inspector"))}</select></label>
            <div class="actions">
              <button class="primary">${state._editingPlan ? "保存修改" : "创建计划"}</button>
              ${state._editingPlan ? `<button class="ghost" type="button" id="cancelPlanEditBtn">取消</button>` : ""}
            </div>
          </form>
        </div>` : ""}
      </div>
      ${currentRole === "inspector" ? `
      <div class="panel">
        <h3>执行巡检</h3>
        <form class="form" id="inspectionForm">
          <label>资产<select name="assetId">${state.assets.filter(a => a.status !== "RETIRED").map(asset => `<option value="${asset.id}">${asset.code} - ${asset.name}</option>`).join("")}</select></label>
          <label>巡检结果<select name="result"><option value="NORMAL">正常</option><option value="ABNORMAL">异常，自动生成工单</option></select></label>
          <label>现场描述<textarea name="description" required placeholder="填写设备状态、异常现象、现场照片说明"></textarea></label>
          <button class="primary">提交巡检记录</button>
        </form>
      </div>` : ""}
    </section>
    <section class="panel" style="margin-top:16px">
      <h3>巡检记录 <span class="meta">共 ${myInspections().length} 条</span></h3>
      <div class="db-table-wrap"><table>
        <thead><tr><th>时间</th><th>资产</th><th>结果</th><th>描述</th><th>关联工单</th></tr></thead>
        <tbody>${myInspections().map(item => `<tr><td>${item.conductedAt}</td><td>${assetName(item.assetId)}</td><td>${item.result === "NORMAL" ? tag("ACTIVE") : tag("MAINTENANCE")}</td><td>${item.description}</td><td>${item.workOrderId ? `<span class="tag">${item.workOrderId}</span>` : "-"}</td></tr>`).join("")}</tbody>
      </table></div>
    </section>
  `);
  const planForm = $("#planForm");
  if (planForm) planForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (currentRole !== "admin") return alert("只有资产管理员可以管理巡检计划");
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (data.planEditId) {
      const plan = state.plans.find(p => p.id === data.planEditId);
      if (plan) { plan.assetId = data.planAssetId; plan.cycle = data.planCycle; plan.nextDate = data.planNextDate; plan.inspector = data.planInspector || currentUserName("inspector"); addLog(plan.id, "巡检计划已更新"); notify("计划更新", "巡检计划已更新"); delete state._editingPlan; }
    } else {
      const exists = state.plans.some(p => p.assetId === data.planAssetId);
      if (exists) return alert("该资产已有巡检计划");
      state.plans.unshift({ id: uid("plan"), assetId: data.planAssetId, cycle: data.planCycle, inspector: data.planInspector || currentUserName("inspector"), nextDate: data.planNextDate });
      addLog(data.planAssetId, `新增巡检计划（${data.planCycle}）`);
      notify("计划新增", "已创建巡检计划");
    }
    await saveState(); render();
  });
  const cancelPlanBtn = $("#cancelPlanEditBtn");
  if (cancelPlanBtn) cancelPlanBtn.addEventListener("click", () => { delete state._editingPlan; render(); });
  document.querySelectorAll("[data-plan-edit]").forEach(btn => {
    btn.addEventListener("click", () => { state._editingPlan = btn.dataset.planEdit; render(); });
  });
  document.querySelectorAll("[data-plan-delete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认删除该巡检计划吗？")) return;
      state.plans = state.plans.filter(p => p.id !== btn.dataset.planDelete);
      addLog(btn.dataset.planDelete, "巡检计划已删除");
      await saveState(); render();
    });
  });
  const inspForm = $("#inspectionForm");
  if (inspForm) inspForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (currentRole !== "inspector") return alert("只有巡检员可以执行巡检");
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const asset = state.assets.find(item => item.id === data.assetId);
    if (!asset) return alert("资产不存在");
    let workOrderId = null;
    if (data.result === "ABNORMAL") {
      const code = `WO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String(state.workOrders.length + 1).padStart(3, "0")}`;
      workOrderId = uid("wo");
      state.workOrders.unshift({ id: workOrderId, code, assetId: asset.id, title: `${asset.name}巡检异常`, description: data.description, status: "PENDING_ACCEPT", reporter: "系统巡检", handler: "", result: "", createdAt: nowText(), updatedAt: nowText() });
      asset.status = "MAINTENANCE";
      notify("异常巡检", `${asset.name} 已自动生成维修工单 ${code}`);
      addLog(asset.code, `异常巡检生成工单 ${code}`);
    } else {
      asset.status = "ACTIVE";
      addLog(asset.code, "巡检正常，更新最近巡检时间");
    }
    state.inspections.unshift({ id: uid("record"), assetId: data.assetId, inspector: currentUserName(), result: data.result, description: data.description, conductedAt: nowText(), workOrderId });
    const plan = state.plans.find(p => p.assetId === data.assetId);
    if (plan) {
      const daysToAdd = { "每日": 1, "每周": 7, "每两周": 14, "每月": 30, "每季度": 90 }[plan.cycle] || 7;
      const d = new Date(); d.setDate(d.getDate() + daysToAdd);
      plan.nextDate = d.toISOString().slice(0, 10);
    }
    await saveState();
    render();
  });
}

function nextActions(order) {
  const actions = [];
  if (currentRole === "admin" && order.status === "PENDING_ACCEPT") actions.push(["受理", "PENDING_ASSIGN"]);
  if (currentRole === "admin" && order.status === "PENDING_ASSIGN") actions.push(["确认派单", "PENDING_PROCESS"]);
  if (canCurrentWorkerHandle(order) && order.status === "PENDING_PROCESS") actions.push(["开始处理", "PROCESSING"]);
  if (canCurrentWorkerHandle(order) && order.status === "PROCESSING") actions.push(["submitResult", "submit"]);
  if (currentRole === "reporter" && order.status === "PENDING_CONFIRM") actions.push(["确认完成", "DONE"], ["反馈未解决", "FEEDBACK"]);
  if (currentRole === "admin" && order.status === "FEEDBACK") actions.push(["重新受理", "PENDING_ASSIGN"]);
  return actions;
}

function ordersView() {
  shell(`
    <section>
      ${currentRole === "reporter" ? `
      <div class="panel" style="margin-bottom:16px">
        <h3>直接报修</h3>
        <p class="meta" style="margin:0 0 12px">作为师生用户，您可以直接提交资产报修请求，系统将自动生成工单。</p>
        <form class="form" id="reportForm">
          <label>报修资产<select name="reportAssetId" required>${state.assets.filter(a => a.status !== "RETIRED").map(a => `<option value="${a.id}">${a.code} - ${a.name}（${a.location}）</option>`).join("")}</select></label>
          <label>问题描述<textarea name="reportDesc" required placeholder="请详细描述设备故障现象..."></textarea></label>
          <button class="primary">提交报修</button>
        </form>
      </div>` : ""}
      <div class="grid cards">
        ${myWorkOrders().map(order => `
          <article class="card">
            <h4>${order.title}</h4>
            <div class="meta">
              ${order.code}<br>${assetName(order.assetId)}<br>
              状态：${tag(order.status)}<br>
              处理人：${order.handler || "待分配"}<br>
              ${order.description}<br>
              ${order.result ? `<strong>维修结果：</strong>${order.result}` : ""}
            </div>
            <div class="actions">
              ${currentRole === "admin" && order.status === "PENDING_ASSIGN" ? `
                <select data-worker-select="${order.id}" aria-label="选择维修人员">
                  ${userOptions("worker", order.handler || defaultWorkerName())}
                </select>
              ` : ""}
              ${currentRole === "worker" && order.status === "PROCESSING" ? `
                <textarea data-result-input="${order.id}" placeholder="输入维修结果描述..." style="width:100%;min-height:60px;margin-bottom:6px">${(order.result || "").replace(/"/g, "&quot;")}</textarea>
              ` : ""}
              ${nextActions(order).map(([label, next]) => {
                if (next === "submit") return `<button class="primary" data-order="${order.id}" data-next="PENDING_CONFIRM" data-need-result="true">提交维修结果</button>`;
                return `<button class="primary" data-order="${order.id}" data-next="${next}">${label}</button>`;
              }).join("")}
            </div>
          </article>
        `).join("")}
        ${myWorkOrders().length === 0 ? `<div class="empty" style="grid-column:1/-1">暂无维修工单</div>` : ""}
      </div>
    </section>
  `);
  const reportForm = $("#reportForm");
  if (reportForm) reportForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (currentRole !== "reporter") return alert("只有师生用户可以报修");
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const asset = state.assets.find(a => a.id === data.reportAssetId);
    if (!asset) return alert("资产不存在");
    const code = `WO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String(state.workOrders.length + 1).padStart(3, "0")}`;
    const orderId = uid("wo");
    state.workOrders.unshift({ id: orderId, code, assetId: asset.id, title: `${asset.name}用户报修`, description: data.reportDesc, status: "PENDING_ACCEPT", reporter: currentUserName(), handler: "", result: "", createdAt: nowText(), updatedAt: nowText() });
    asset.status = "MAINTENANCE";
    addLog(code, `师生用户 ${currentUserName()} 提交报修：${data.reportDesc}`);
    notify("用户报修", `${asset.name} 报修工单 ${code} 已生成`);
    await saveState(); render();
  });
  document.querySelectorAll("[data-order]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const order = state.workOrders.find(item => item.id === btn.dataset.order);
      if (!order) return;
      const asset = state.assets.find(item => item.id === order.assetId);
      const next = btn.dataset.next;
      if (btn.dataset.needResult === "true") {
        const resultInput = document.querySelector(`[data-result-input="${order.id}"]`);
        const resultText = resultInput?.value?.trim();
        if (!resultText) return alert("请填写维修结果描述");
        order.result = resultText;
      }
      order.status = next;
      order.updatedAt = nowText();
      if (next === "PENDING_PROCESS") order.handler = document.querySelector(`[data-worker-select="${order.id}"]`)?.value || defaultWorkerName();
      if (next === "DONE" && asset) asset.status = "ACTIVE";
      if (next === "FEEDBACK" && asset) asset.status = "MAINTENANCE";
      addLog(order.code, `${roleMap[currentRole].name} 执行操作：${statusMap[next] ? statusMap[next][0] : next}`);
      notify("工单状态更新", `${order.code} 已变更为 ${statusMap[next] ? statusMap[next][0] : next}`);
      await saveState();
      render();
    });
  });
}

function logsView() {
  shell(`
    <section class="grid two-col">
      <div class="panel">
        <h3>操作日志 <span class="meta">共 ${myLogs().length} 条</span></h3>
        <div class="timeline">
          ${myLogs().map(log => `<div class="timeline-item"><div class="timeline-dot"></div><div><strong>${log.target}</strong><br><span>${log.content}</span><br><small>${log.time}</small></div></div>`).join("")}
          ${myLogs().length === 0 ? `<div class="empty">暂无操作日志</div>` : ""}
        </div>
      </div>
      <div class="panel">
        <h3>实时通知 <span class="meta">共 ${state.notifications.length} 条</span></h3>
        <div class="timeline">
          ${state.notifications.map(item => `<div class="timeline-item"><div class="timeline-dot"></div><div><strong>${item.title}</strong><br><span>${item.content}</span><br><small>${item.time}</small></div></div>`).join("")}
          ${state.notifications.length === 0 ? `<div class="empty">暂无通知</div>` : ""}
        </div>
      </div>
    </section>
  `);
}

function showAssetDetail(assetId) {
  const asset = state.assets.find(a => a.id === assetId);
  if (!asset) return;
  const inspections = state.inspections.filter(r => r.assetId === assetId);
  const orders = state.workOrders.filter(o => o.assetId === assetId);
  const plan = state.plans.find(p => p.assetId === assetId);
  const now = new Date();
  const isExpired = asset.warrantyEnd && new Date(asset.warrantyEnd) < now;
  const isExpiring = asset.warrantyEnd && !isExpired && new Date(asset.warrantyEnd) <= new Date(now.getTime() + 30 * 86400000);
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `
    <div class="modal-card">
      <div class="modal-head">
        <h2>资产详情：${asset.code}</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="grid two-col" style="margin-bottom:16px">
          <div>
            <h3>基本信息</h3>
            <table>
              <tr><td style="width:80px;color:var(--muted)">编码</td><td><strong>${asset.code}</strong></td></tr>
              <tr><td style="color:var(--muted)">名称</td><td>${asset.name}</td></tr>
              <tr><td style="color:var(--muted)">分类</td><td>${asset.category}</td></tr>
              <tr><td style="color:var(--muted)">型号</td><td>${asset.model || "-"}</td></tr>
              <tr><td style="color:var(--muted)">位置</td><td>${asset.location}</td></tr>
              <tr><td style="color:var(--muted)">责任人</td><td>${asset.owner || "-"}</td></tr>
              <tr><td style="color:var(--muted)">状态</td><td>${tag(asset.status)}</td></tr>
            </table>
          </div>
          <div>
            <h3>时间与保修</h3>
            <table>
              <tr><td style="width:80px;color:var(--muted)">购置日期</td><td>${asset.purchaseDate || "-"}</td></tr>
              <tr><td style="color:var(--muted)">保修到期</td><td>${asset.warrantyEnd || "-"} ${isExpired ? `<span class="tag danger">已过期</span>` : isExpiring ? `<span class="tag warn">即将过期</span>` : ""}</td></tr>
              <tr><td style="color:var(--muted)">巡检计划</td><td>${plan ? `${plan.cycle} / ${plan.inspector} / 下次: ${plan.nextDate}` : "无计划"}</td></tr>
              <tr><td style="color:var(--muted)">二维码</td><td><span class="tag dark">${asset.qr || asset.code}</span></td></tr>
            </table>
          </div>
        </div>
        <div class="grid two-col">
          <div>
            <h3>巡检历史 <span class="meta">${inspections.length} 条</span></h3>
            <div class="db-table-wrap"><table>
              <thead><tr><th>时间</th><th>结果</th><th>描述</th></tr></thead>
              <tbody>${inspections.map(r => `<tr><td>${r.conductedAt}</td><td>${r.result === "NORMAL" ? tag("ACTIVE") : tag("MAINTENANCE")}</td><td>${r.description}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">暂无记录</td></tr>`}</tbody>
            </table></div>
          </div>
          <div>
            <h3>维修历史 <span class="meta">${orders.length} 条</span></h3>
            <div class="db-table-wrap"><table>
              <thead><tr><th>工单</th><th>状态</th><th>处理人</th></tr></thead>
              <tbody>${orders.map(o => `<tr><td><strong>${o.code}</strong><br><span class="meta">${o.title}</span></td><td>${tag(o.status)}</td><td>${o.handler || "-"}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">暂无记录</td></tr>`}</tbody>
            </table></div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  mask.addEventListener("click", e => { if (e.target === mask || e.target.classList.contains("modal-close")) mask.remove(); });
}

function render() {
  if (!currentRole) return loginScreen();
  if (currentRole === "dba") return; // DBA uses its own panel, not app shell
  document.querySelectorAll(".modal-mask").forEach(m => m.remove());
  const views = { dashboard: dashboardView, assets: assetsView, inspection: inspectionView, orders: ordersView, logs: logsView };
  views[activeView]();
}

loadState().then(render);
