(() => {
  "use strict";

  const sessionKey = "campus-db-admin-session";
  const assetLoginKey = "campus-asset-auth-user";
  const sessionMaxAge = 8 * 60 * 60 * 1000;
  const tabs = [
    ["overview", "总览"],
    ["users", "用户角色"],
    ["assets", "资产"],
    ["inspection", "巡检"],
    ["orders", "工单"],
    ["data", "数据"],
    ["system", "系统"]
  ];

  let state = {};
  let backups = [];
  let metrics = null;
  let activeTab = "overview";

  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const nowText = () => new Date().toLocaleString("zh-CN", { hour12: false });

  function readJsonStorage(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (error) {
      return null;
    }
  }

  function isFreshSession(session) {
    return session && Date.now() - Number(session.time || 0) < sessionMaxAge;
  }

  function defaultPasswordFor(username) {
    const defaults = {
      admin: "admin123",
      inspector: "inspect123",
      worker: "worker123",
      reporter: "user123",
      dbadmin: "dbadmin123"
    };
    return defaults[username] || "";
  }

  function validatePassword(password) {
    return typeof password === "string" && password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
  }

  function confirmAction(message) {
    return window.confirm(message);
  }

  function projectType() {
    return Array.isArray(state.assets) || Array.isArray(state.plans) ? "asset" : "workorder";
  }

  function orders() {
    return state.workOrders || state.orders || [];
  }

  function setOrders(items) {
    if (Array.isArray(state.workOrders)) state.workOrders = items;
    else state.orders = items;
  }

  function assets() {
    return state.assets || [];
  }

  function filterAssets() {
    const keyword = (sessionStorage.getItem("asset-filter") || "").toLowerCase();
    const status = sessionStorage.getItem("asset-status-filter") || "";
    const category = sessionStorage.getItem("asset-category-filter") || "";
    const minRaw = sessionStorage.getItem("asset-min-value") || "";
    const maxRaw = sessionStorage.getItem("asset-max-value") || "";
    const minValue = minRaw === "" ? NaN : Number(minRaw);
    const maxValue = maxRaw === "" ? NaN : Number(maxRaw);
    return assets().filter(asset => {
      const matchedKeyword = [asset.name, asset.code, asset.category, asset.location, asset.owner, asset.status]
        .some(value => String(value || "").toLowerCase().includes(keyword));
      const value = depreciationValue(asset);
      return matchedKeyword
        && (!status || asset.status === status)
        && (!category || asset.category === category)
        && (!Number.isFinite(minValue) || value >= minValue)
        && (!Number.isFinite(maxValue) || value <= maxValue);
    });
  }

  function filterOrders() {
    const keyword = (sessionStorage.getItem("order-filter") || "").toLowerCase();
    const status = sessionStorage.getItem("order-status-filter") || "";
    const priority = sessionStorage.getItem("order-priority-filter") || "";
    return orders().filter(order => {
      const matchedKeyword = [order.code, order.title, order.status, order.category, order.assetId, order.handler, order.priority]
        .some(value => String(value || "").toLowerCase().includes(keyword));
      return matchedKeyword
        && (!status || order.status === status)
        && (!priority || (order.priority || "中") === priority);
    });
  }

  function ensureState() {
    if (!Array.isArray(state.users)) state.users = [];
    if (!Array.isArray(state.roles)) {
      state.roles = [
        { id: "role-dba", name: "数据库管理员", code: "dba", permissions: ["*"] },
        { id: "role-admin", name: "管理员", code: "admin", permissions: ["asset:*", "inspection:*", "workorder:*", "report:*"] },
        { id: "role-inspector", name: "巡检员", code: "inspector", permissions: ["inspection:read", "inspection:write"] },
        { id: "role-worker", name: "维修人员", code: "worker", permissions: ["workorder:read", "workorder:write"] },
        { id: "role-reporter", name: "师生用户", code: "reporter", permissions: ["workorder:read"] }
      ];
    }
    if (!state.users.some(user => user.username === "dbadmin")) {
      state.users.unshift({ id: "u-dba", name: "数据库管理员", username: "dbadmin", password: "dbadmin123", role: "dba", roleId: "role-dba", status: "enabled" });
    }
    if (!Array.isArray(state.auditLogs)) state.auditLogs = [];
    if (!Array.isArray(state.systemLogs)) state.systemLogs = [];
    if (!state.settings) state.settings = { systemName: projectType() === "asset" ? "校园资产巡检平台" : "校园 AI 工单系统", notifyInApp: true, notifyEmail: false, notifySms: false, backupCycle: "daily" };
    if (!state.dictionaries) {
      state.dictionaries = {
        assetCategories: ["教学设备", "宿舍设施", "网络设备", "教学仪器"],
        assetStatuses: ["ACTIVE", "PENDING_INSPECTION", "MAINTENANCE", "RETIRED"],
        workOrderCategories: ["设备", "水电", "网络", "宿舍"],
        priorities: ["高", "中", "低"]
      };
    }
    if (!Array.isArray(state.templates)) {
      state.templates = [
        { id: "tpl-1", title: "投影仪无信号", category: "设备", priority: "中", content: "检查输入源、中控重启、线缆替换。" },
        { id: "tpl-2", title: "网络中断", category: "网络", priority: "高", content: "记录位置、端口和现象，优先排查交换机与认证。" }
      ];
    }
  }

  async function loadState() {
    showLoading(true);
    const res = await fetch("/api/state");
    state = await res.json();
    ensureState();
    showLoading(false);
  }

  async function saveState(action, target, detail) {
    showLoading(true);
    localStorage.setItem("campus-db-admin-undo", JSON.stringify(state));
    if (action) {
      state.auditLogs.unshift({ id: uid("audit"), action, target, detail, time: nowText() });
      state.auditLogs = state.auditLogs.slice(0, 300);
    }
    const res = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    showLoading(false);
    if (!res.ok) throw new Error("保存失败");
    toast("操作已保存");
  }

  function isDbaSignedIn() {
    const session = readJsonStorage(sessionKey);
    if (!session || session.role !== "dba") return false;
    if (!isFreshSession(session)) {
      localStorage.removeItem(sessionKey);
      return false;
    }
    return true;
  }

  function roleName(roleId, code) {
    const role = state.roles.find(item => item.id === roleId || item.code === code);
    return role ? role.name : code || roleId || "-";
  }

  function field(name, fallback = "") {
    const el = $(`[name="${name}"]`);
    return el ? el.value.trim() : fallback;
  }

  function toast(message) {
    const node = document.createElement("div");
    node.className = "db-toast";
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 2200);
  }

  function showLoading(show) {
    let node = $(".db-loading");
    if (!node) {
      node = document.createElement("div");
      node.className = "db-loading";
      node.textContent = "正在处理...";
      document.body.appendChild(node);
    }
    node.classList.toggle("show", Boolean(show));
  }

  function shell(content) {
    return `
      <section class="db-admin-panel">
        <header class="db-admin-head">
          <div>
            <h2>数据库管理员工作台</h2>
            <p>增量增强层：用户、角色、资产、巡检、工单、备份、审计和系统配置</p>
          </div>
          <button class="db-admin-close" data-action="close">×</button>
        </header>
        ${isDbaSignedIn() ? `<nav class="db-tabs">${tabs.map(([key, label]) => `<button class="${activeTab === key ? "active" : ""}" data-tab="${key}">${label}</button>`).join("")}</nav>` : `<nav class="db-tabs"><button class="active">安全登录</button></nav>`}
        <main class="db-body">${content}</main>
      </section>
    `;
  }

  function renderPanel() {
    const mask = $(".db-admin-mask");
    if (!isDbaSignedIn()) {
      mask.innerHTML = shell(renderDbaLogin());
      return;
    }
    const views = { overview: renderOverview, users: renderUsers, assets: renderAssets, inspection: renderInspection, orders: renderOrders, data: renderData, system: renderSystem };
    mask.innerHTML = shell((views[activeTab] || renderOverview)());
  }

  function renderDbaLogin(error = "") {
    return `
      <section class="db-grid">
        <div class="db-card">
          <h3>数据库管理员登录</h3>
          <p class="db-muted">默认账号：dbadmin / dbadmin123。登录后可进行用户角色管理、数据备份恢复、审计查询和批量维护。</p>
          <form class="db-form" data-form="dba-login">
            <label>账号<input name="dbaUsername" value="dbadmin" autocomplete="username" required></label>
            <label>密码<input name="dbaPassword" type="password" value="dbadmin123" autocomplete="current-password" required></label>
            ${error ? `<div class="upgrade-login-error">${esc(error)}</div>` : ""}
            <button class="primary">登录管理台</button>
          </form>
        </div>
        <div class="db-card">
          <h3>当前存储</h3>
          <p class="db-muted">REST API、缓存读取、并发写入队列、备份恢复和接口文档已在后端启用。PostgreSQL 连接信息可通过 DATABASE_URL 配置，当前演示保留 JSON 回退存储。</p>
          <div class="db-actions"><a class="ghost" href="/api/docs" target="_blank" rel="noreferrer">查看 API 文档</a></div>
        </div>
      </section>
    `;
  }

  function renderOverview() {
    const overduePlans = (state.plans || []).filter(plan => plan.nextDate && plan.nextDate < new Date().toISOString().slice(0, 10));
    const openOrders = orders().filter(order => !["DONE", "CANCELLED", "KB_SOLVED"].includes(order.status)).length;
    return `
      <section class="db-grid">
        ${kpi("用户", state.users.length, "已启用账号与演示账号")}
        ${kpi("角色", state.roles.length, "支持新增、修改、删除和权限")}
        ${kpi("资产", assets().length, "搜索、调拨、折旧、标签")}
        ${kpi("未结工单", openOrders, "优先级、分类、工时、模板")}
        <div class="db-card full">
          <h3>待处理提醒</h3>
          <div class="db-actions">
            <span class="db-badge ${overduePlans.length ? "warn" : "ok"}">到期巡检 ${overduePlans.length}</span>
            <span class="db-badge ${openOrders ? "warn" : "ok"}">未结工单 ${openOrders}</span>
            <span class="db-badge">审计记录 ${state.auditLogs.length}</span>
            <span class="db-badge">运行日志 ${state.systemLogs.length}</span>
          </div>
        </div>
      </section>
    `;
  }

  function kpi(label, value, note) {
    return `<div class="db-card third db-kpi"><span class="db-muted">${label}</span><strong>${value}</strong><span class="db-muted">${note}</span></div>`;
  }

  function renderUsers() {
    return `
      <section class="db-grid">
        <div class="db-card full">
          <h3>用户管理</h3>
          <form class="db-form" data-form="user-create">
            <div class="db-row">
              <label>姓名<input name="userName" required></label>
              <label>账号<input name="userUsername" required></label>
            </div>
            <div class="db-row">
              <label>密码<input name="userPassword" value="123456" required></label>
              <label>角色<select name="userRole">${state.roles.map(role => `<option value="${role.id}">${esc(role.name)}</option>`).join("")}</select></label>
            </div>
            <button class="primary">新增用户</button>
          </form>
          <div class="db-table-wrap"><table class="db-table">
            <thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>${state.users.map(user => `
              <tr>
                <td>${esc(user.name)}</td><td>${esc(user.username)}</td><td>${esc(roleName(user.roleId, user.role))}</td>
                <td><span class="db-badge ${user.status === "disabled" ? "danger" : "ok"}">${user.status === "disabled" ? "停用" : "启用"}</span></td>
                <td class="db-actions">
                  <button class="ghost" data-action="user-reset" data-id="${esc(user.id)}">重置密码</button>
                  <button class="ghost" data-action="user-toggle" data-id="${esc(user.id)}">${user.status === "disabled" ? "启用" : "停用"}</button>
                  <button class="danger" data-action="user-delete" data-id="${esc(user.id)}">删除</button>
                </td>
              </tr>`).join("")}</tbody>
          </table></div>
        </div>
        <div class="db-card full">
          <h3>角色与权限</h3>
          <form class="db-form" data-form="role-create">
            <div class="db-row">
              <label>角色名称<input name="roleName" required></label>
              <label>角色编码<input name="roleCode" required placeholder="如 asset_auditor"></label>
            </div>
            <label>权限标识<input name="rolePermissions" placeholder="asset:read,asset:write,report:*" required></label>
            <button class="primary">新增角色</button>
          </form>
          <div class="db-table-wrap"><table class="db-table">
            <thead><tr><th>名称</th><th>编码</th><th>权限</th><th>操作</th></tr></thead>
            <tbody>${state.roles.map(role => `
              <tr><td>${esc(role.name)}</td><td>${esc(role.code)}</td><td>${esc((role.permissions || []).join(", "))}</td>
              <td><button class="danger" data-action="role-delete" data-id="${esc(role.id)}">删除</button></td></tr>`).join("")}</tbody>
          </table></div>
        </div>
      </section>
    `;
  }

  function renderAssets() {
    if (!assets().length && projectType() !== "asset") {
      return `<section class="db-card full"><h3>资产模块</h3><p class="db-muted">当前项目以工单为核心，未配置资产台账。可通过批量导入创建资产数据。</p>${assetImportBox()}</section>`;
    }
    const keyword = (sessionStorage.getItem("asset-filter") || "").toLowerCase();
    const statusFilter = sessionStorage.getItem("asset-status-filter") || "";
    const categoryFilter = sessionStorage.getItem("asset-category-filter") || "";
    const minValue = sessionStorage.getItem("asset-min-value") || "";
    const maxValue = sessionStorage.getItem("asset-max-value") || "";
    const statuses = [...new Set(assets().map(asset => asset.status).filter(Boolean))];
    const categories = [...new Set(assets().map(asset => asset.category).filter(Boolean))];
    const list = filterAssets();
    const selected = assets().find(asset => asset.id === sessionStorage.getItem("asset-detail-id")) || list[0] || {};
    return `
      <section class="db-grid">
        <div class="db-card full">
          <h3>资产搜索与批量操作</h3>
          <div class="db-actions">
            <input id="assetSearch" placeholder="按名称、编码、分类、位置、负责人、状态搜索" value="${esc(keyword)}">
            <select id="assetStatusFilter"><option value="">全部状态</option>${statuses.map(status => `<option value="${esc(status)}" ${status === statusFilter ? "selected" : ""}>${esc(status)}</option>`).join("")}</select>
            <select id="assetCategoryFilter"><option value="">全部分类</option>${categories.map(category => `<option value="${esc(category)}" ${category === categoryFilter ? "selected" : ""}>${esc(category)}</option>`).join("")}</select>
            <input id="assetMinValue" type="number" min="0" placeholder="估值下限" value="${esc(minValue)}">
            <input id="assetMaxValue" type="number" min="0" placeholder="估值上限" value="${esc(maxValue)}">
            <button class="ghost" data-action="asset-search">搜索</button>
            <button class="ghost" data-action="asset-export-csv">导出 CSV</button>
            <button class="ghost" data-action="asset-print-tags">打印标签</button>
            <button class="danger" data-action="asset-delete-selected">批量删除</button>
          </div>
          <div class="db-table-wrap"><table class="db-table">
            <thead><tr><th><input type="checkbox" data-action="toggle-asset-check"></th><th>编码/名称</th><th>分类</th><th>位置</th><th>状态</th><th>折旧估值</th><th>详情</th></tr></thead>
            <tbody>${list.map(asset => `<tr>
              <td><input type="checkbox" data-asset-check value="${esc(asset.id)}"></td>
              <td><strong>${esc(asset.code)}</strong><br><span class="db-muted">${esc(asset.name)} ${esc(asset.model || "")}</span></td>
              <td>${esc(asset.category)}</td><td>${esc(asset.location)}<br><span class="db-muted">${esc(asset.owner || "")}</span></td>
              <td><span class="db-badge">${esc(asset.status)}</span></td><td>${depreciation(asset)}</td>
              <td><button class="ghost" data-action="asset-detail" data-id="${esc(asset.id)}">查看</button></td>
            </tr>`).join("")}</tbody>
          </table></div>
        </div>
        <div class="db-card">
          <h3>资产详情</h3>
          <p class="db-muted">${selected.id ? assetDetail(selected) : "请选择资产查看详情。"}</p>
          ${selected.id ? `
            <form class="db-form" data-form="asset-depreciation">
              <input type="hidden" name="assetId" value="${esc(selected.id)}">
              <label>原值<input name="originalValue" type="number" min="0" step="1" value="${esc(selected.originalValue || selected.price || 5000)}"></label>
              <label>手动估值<input name="depreciationValue" type="number" min="0" step="1" value="${esc(selected.depreciationValue || "")}" placeholder="留空则自动计算"></label>
              <button class="primary">保存折旧估值</button>
            </form>
          ` : ""}
        </div>
        <div class="db-card">
          <h3>资产转移/调拨</h3>
          <form class="db-form" data-form="asset-transfer">
            <label>资产<select name="transferAsset">${assets().map(asset => `<option value="${esc(asset.id)}">${esc(asset.code)} - ${esc(asset.name)}</option>`).join("")}</select></label>
            <label>新位置<input name="transferLocation" required></label>
            <label>新责任部门/负责人<input name="transferOwner" required></label>
            <button class="primary">确认调拨</button>
          </form>
        </div>
        ${assetImportBox()}
      </section>
    `;
  }

  function assetDetail(asset) {
    const inspectionCount = (state.inspections || []).filter(item => item.assetId === asset.id).length;
    const maintenanceCount = orders().filter(order => order.assetId === asset.id).length;
    return `编码：${esc(asset.code)}<br>名称：${esc(asset.name)}<br>分类：${esc(asset.category)}<br>型号：${esc(asset.model || "-")}<br>位置：${esc(asset.location)}<br>责任人：${esc(asset.owner || "-")}<br>购置日期：${esc(asset.purchaseDate || "-")}<br>保修到期：${esc(asset.warrantyEnd || "-")}<br>巡检次数：${inspectionCount}<br>维修记录：${maintenanceCount}<br>二维码：${esc(asset.qr || asset.code)}`;
  }

  function depreciationValue(asset) {
    if (asset.depreciationValue !== undefined && asset.depreciationValue !== "") return Number(asset.depreciationValue) || 0;
    const base = Number(asset.originalValue || asset.price || 5000);
    const date = asset.purchaseDate ? new Date(asset.purchaseDate) : new Date();
    const years = Math.max(0, (Date.now() - date.getTime()) / 31536000000);
    const timeValue = Math.max(base * 0.05, base - (base * 0.95 * Math.min(years, 5)) / 5);
    const inspectionCount = (state.inspections || []).filter(item => item.assetId === asset.id).length;
    const maintenanceCount = orders().filter(order => order.assetId === asset.id).length;
    const usageFactor = Math.max(0.6, 1 - inspectionCount * 0.01 - maintenanceCount * 0.04);
    return Math.max(base * 0.05, Math.round(timeValue * usageFactor));
  }

  function depreciation(asset) {
    return `¥${Math.round(depreciationValue(asset))}`;
  }

  function assetImportBox() {
    return `
      <div class="db-card full">
        <h3>资产批量导入</h3>
        <form class="db-form" data-form="asset-import">
          <textarea name="assetImport" placeholder='支持 JSON 数组，或 CSV：code,name,category,location,owner'></textarea>
          <button class="primary">导入资产</button>
        </form>
      </div>
    `;
  }

  function renderInspection() {
    const plans = state.plans || [];
    const inspections = state.inspections || [];
    const today = new Date().toISOString().slice(0, 10);
    const overdue = plans.filter(plan => plan.nextDate && plan.nextDate <= today);
    const coverage = assets().length ? Math.round((new Set(inspections.map(item => item.assetId)).size / assets().length) * 100) : 0;
    const onTime = plans.length ? Math.round(((plans.length - overdue.length) / plans.length) * 100) : 100;
    return `
      <section class="db-grid">
        ${kpi("巡检覆盖率", `${coverage}%`, "按已巡检资产去重计算")}
        ${kpi("按时率", `${onTime}%`, "基于计划到期日期")}
        ${kpi("到期提醒", overdue.length, "需要优先处理")}
        <div class="db-card full">
          <h3>可视化路线规划</h3>
          <div class="db-route">${plans.map((plan, index) => {
            const asset = assets().find(item => item.id === plan.assetId) || {};
            return `<div class="db-route-step"><i>${index + 1}</i><div><strong>${esc(asset.location || "未设置位置")}</strong><br><span class="db-muted">${esc(asset.name || plan.assetId)}，负责人：${esc(plan.inspector || "-")}，下次巡检：${esc(plan.nextDate || "-")}</span></div></div>`;
          }).join("") || `<p class="db-muted">暂无巡检计划。</p>`}</div>
        </div>
        <div class="db-card">
          <h3>任务分配</h3>
          <form class="db-form" data-form="inspection-assign">
            <label>计划<select name="planId">${plans.map(plan => `<option value="${esc(plan.id)}">${esc(plan.id)} - ${esc(plan.nextDate || "")}</option>`).join("")}</select></label>
            <label>巡检员<input name="planInspector" required placeholder="输入巡检员姓名"></label>
            <label>下次巡检日期<input name="planNextDate" type="date" required></label>
            <button class="primary">保存分配</button>
          </form>
        </div>
        <div class="db-card">
          <h3>现场图片上传</h3>
          <label>巡检记录<select id="photoInspection">${inspections.map(item => `<option value="${esc(item.id)}">${esc(item.conductedAt || item.id)}</option>`).join("")}</select></label>
          <input type="file" accept="image/*" data-photo-upload>
          <p class="db-muted">图片将以 Base64 演示数据保存到巡检记录中。</p>
        </div>
      </section>
    `;
  }

  function renderOrders() {
    const keyword = (sessionStorage.getItem("order-filter") || "").toLowerCase();
    const statusFilter = sessionStorage.getItem("order-status-filter") || "";
    const priorityFilter = sessionStorage.getItem("order-priority-filter") || "";
    const statuses = [...new Set(orders().map(order => order.status).filter(Boolean))];
    const priorities = ["高", "中", "低"];
    const list = filterOrders();
    return `
      <section class="db-grid">
        <div class="db-card full">
          <h3>工单搜索与增强字段</h3>
          <div class="db-actions">
            <input id="orderSearch" placeholder="按工单号、资产、状态、分类、处理人搜索" value="${esc(keyword)}">
            <select id="orderStatusFilter"><option value="">全部状态</option>${statuses.map(status => `<option value="${esc(status)}" ${status === statusFilter ? "selected" : ""}>${esc(status)}</option>`).join("")}</select>
            <select id="orderPriorityFilter"><option value="">全部优先级</option>${priorities.map(priority => `<option value="${esc(priority)}" ${priority === priorityFilter ? "selected" : ""}>${esc(priority)}</option>`).join("")}</select>
            <button class="ghost" data-action="order-search">搜索</button>
            <button class="ghost" data-action="order-export-csv">导出 CSV</button>
          </div>
          <div class="db-table-wrap"><table class="db-table">
            <thead><tr><th>工单</th><th>分类</th><th>优先级</th><th>状态</th><th>工时</th><th>处理人</th><th>操作</th></tr></thead>
            <tbody>${list.map(order => `<tr>
              <td><strong>${esc(order.code)}</strong><br><span class="db-muted">${esc(order.title || order.description)}</span></td>
              <td>${esc(order.category || "未分类")}</td>
              <td><span class="db-badge ${order.priority === "高" ? "danger" : order.priority === "低" ? "ok" : "warn"}">${esc(order.priority || "中")}</span></td>
              <td>${esc(order.status)}</td><td>${esc(order.laborHours || 0)} 小时</td><td>${esc(order.handler || "-")}</td>
              <td><button class="ghost" data-action="order-fill-edit" data-id="${esc(order.id)}">编辑</button></td>
            </tr>`).join("")}</tbody>
          </table></div>
        </div>
        <div class="db-card">
          <h3>工单字段维护</h3>
          <form class="db-form" data-form="order-update">
            <label>工单<select name="orderId">${orders().map(order => `<option value="${esc(order.id)}">${esc(order.code)} - ${esc(order.title || "")}</option>`).join("")}</select></label>
            <div class="db-row">
              <label>分类<input name="orderCategory" placeholder="设备/水电/网络"></label>
              <label>优先级<select name="orderPriority"><option>高</option><option selected>中</option><option>低</option></select></label>
            </div>
            <label>维修工时<input name="orderHours" type="number" min="0" step="0.5" value="1"></label>
            <button class="primary">保存工单字段</button>
          </form>
        </div>
        <div class="db-card">
          <h3>常用工单模板</h3>
          <form class="db-form" data-form="template-create">
            <input name="tplTitle" required placeholder="模板标题">
            <div class="db-row"><input name="tplCategory" placeholder="分类"><select name="tplPriority"><option>高</option><option selected>中</option><option>低</option></select></div>
            <textarea name="tplContent" required placeholder="处理步骤"></textarea>
            <button class="primary">新增模板</button>
          </form>
          <div class="db-route">${state.templates.map(item => `<div class="db-route-step"><i>模</i><div><strong>${esc(item.title)}</strong><br><span class="db-muted">${esc(item.category)} / ${esc(item.priority)}：${esc(item.content)}</span></div></div>`).join("")}</div>
        </div>
      </section>
    `;
  }

  function renderData() {
    const collections = projectType() === "asset" ? ["assets", "workOrders", "inspections", "users", "auditLogs"] : ["orders", "workers", "knowledge", "users", "auditLogs"];
    return `
      <section class="db-grid">
        <div class="db-card">
          <h3>数据导出</h3>
          <label>数据集<select id="exportCollection">${collections.map(name => `<option>${name}</option>`).join("")}</select></label>
          <div class="db-actions">
            <button class="ghost" data-action="export-json">JSON</button>
            <button class="ghost" data-action="export-csv">Excel/CSV</button>
            <button class="ghost" data-action="export-pdf">PDF 打印</button>
          </div>
        </div>
        <div class="db-card">
          <h3>备份与恢复</h3>
          <div class="db-actions">
            <button class="primary" data-action="backup-create">创建备份</button>
            <button class="ghost" data-action="backup-refresh">刷新列表</button>
          </div>
          <label>备份文件<select id="backupFile">${backups.map(file => `<option>${esc(file)}</option>`).join("")}</select></label>
          <button class="danger" data-action="backup-restore">恢复选中备份</button>
        </div>
        <div class="db-card full">
          <h3>统计报表</h3>
          <div class="db-table-wrap"><table class="db-table">
            <thead><tr><th>周期</th><th>资产新增</th><th>巡检记录</th><th>工单数量</th><th>完成工单</th></tr></thead>
            <tbody>${reportRows().map(row => `<tr><td>${row.period}</td><td>${row.assets}</td><td>${row.inspections}</td><td>${row.orders}</td><td>${row.done}</td></tr>`).join("")}</tbody>
          </table></div>
        </div>
      </section>
    `;
  }

  function reportRows() {
    const periods = ["月度", "季度", "年度"];
    return periods.map(period => ({
      period,
      assets: assets().length,
      inspections: (state.inspections || []).length,
      orders: orders().length,
      done: orders().filter(order => order.status === "DONE").length
    }));
  }

  function renderSystem() {
    return `
      <section class="db-grid">
        <div class="db-card">
          <h3>系统设置</h3>
          <form class="db-form" data-form="settings-save">
            <label>系统名称<input name="systemName" value="${esc(state.settings.systemName || "")}"></label>
            <div class="db-row">
              <label>备份周期<select name="backupCycle"><option ${state.settings.backupCycle === "daily" ? "selected" : ""} value="daily">每日</option><option ${state.settings.backupCycle === "weekly" ? "selected" : ""} value="weekly">每周</option></select></label>
              <label>通知渠道<input name="channels" value="${["站内", state.settings.notifyEmail ? "邮件" : "", state.settings.notifySms ? "短信" : ""].filter(Boolean).join(",")}"></label>
            </div>
            <button class="primary">保存设置</button>
          </form>
        </div>
        <div class="db-card">
          <h3>数据字典</h3>
          <form class="db-form" data-form="dict-save">
            <textarea name="dictJson">${esc(JSON.stringify(state.dictionaries, null, 2))}</textarea>
            <button class="primary">保存字典</button>
          </form>
        </div>
        <div class="db-card">
          <h3>性能监控</h3>
          <button class="ghost" data-action="metrics-refresh">刷新指标</button>
          <pre class="db-muted">${esc(JSON.stringify(metrics || { message: "点击刷新指标" }, null, 2))}</pre>
        </div>
        <div class="db-card">
          <h3>撤销/回退</h3>
          <p class="db-muted">可回退最近一次由数据库管理员工作台保存的数据。</p>
          <button class="danger" data-action="undo-last">撤销上一次保存</button>
        </div>
        <div class="db-card full">
          <h3>审计与运行日志</h3>
          <div class="db-table-wrap"><table class="db-table">
            <thead><tr><th>时间</th><th>类型</th><th>对象</th><th>内容</th></tr></thead>
            <tbody>${[...state.auditLogs, ...state.systemLogs].slice(0, 80).map(log => `<tr><td>${esc(log.time)}</td><td>${esc(log.action || "system")}</td><td>${esc(log.target || "-")}</td><td>${esc(log.detail || log.content || "")}</td></tr>`).join("")}</tbody>
          </table></div>
        </div>
      </section>
    `;
  }

  function parseRows(text) {
    const value = text.trim();
    if (!value) return [];
    if (value.startsWith("[")) return JSON.parse(value);
    const lines = value.split(/\r?\n/).filter(Boolean);
    const headers = lines.shift().split(",").map(item => item.trim());
    return lines.map(line => {
      const cells = line.split(",").map(item => item.trim());
      return headers.reduce((obj, key, index) => ({ ...obj, [key]: cells[index] || "" }), {});
    });
  }

  function printAssetTags() {
    const selectedIds = [...document.querySelectorAll("[data-asset-check]:checked")].map(input => input.value);
    const list = assets().filter(asset => !selectedIds.length || selectedIds.includes(asset.id));
    const win = window.open("", "_blank");
    if (!win) return toast("浏览器阻止了打印窗口");
    win.document.write(`<!doctype html><meta charset="utf-8"><title>资产标签</title><style>body{font-family:Arial,"Microsoft YaHei";padding:20px}.tag{display:inline-grid;gap:8px;width:210px;height:150px;margin:8px;padding:12px;border:1px solid #111}.qr{width:72px;height:72px;background:repeating-linear-gradient(45deg,#111 0 5px,#fff 5px 10px)}</style>${list.map(asset => `<div class="tag"><strong>${esc(asset.name)}</strong><span>${esc(asset.code)}</span><div class="qr"></div><small>${esc(asset.location || "")}</small></div>`).join("")}<script>window.print()</script>`);
    win.document.close();
  }

  async function refreshBackups() {
    const res = await fetch("/api/backups");
    backups = await res.json();
  }

  async function refreshMetrics() {
    const res = await fetch("/api/metrics");
    metrics = await res.json();
  }

  async function handleForm(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    const kind = form.dataset.form;

    if (kind === "dba-login") {
      const user = state.users.find(item => item.username === data.dbaUsername && item.password === data.dbaPassword && item.status !== "disabled");
      const role = user && state.roles.find(item => item.id === user.roleId || item.code === user.role);
      if (!user || !(user.role === "dba" || role?.code === "dba" || role?.permissions?.includes("*"))) {
        $(".db-body").innerHTML = renderDbaLogin("账号、密码或数据库管理员权限不正确。");
        return;
      }
      localStorage.setItem(sessionKey, JSON.stringify({ username: user.username, role: "dba", time: Date.now() }));
      activeTab = "overview";
      renderPanel();
      return;
    }

    if (kind === "user-create") {
      if (!validatePassword(data.userPassword)) {
        throw new Error("密码至少 8 位，并包含字母和数字");
      }
      if (state.users.some(item => item.username === data.userUsername)) {
        throw new Error("账号已存在");
      }
      const role = state.roles.find(item => item.id === data.userRole);
      state.users.unshift({ id: uid("u"), name: data.userName, username: data.userUsername, password: data.userPassword, role: role?.code || "custom", roleId: data.userRole, status: "enabled" });
      await saveState("user.create", data.userUsername, "新增用户");
    }
    if (kind === "role-create") {
      state.roles.unshift({ id: uid("role"), name: data.roleName, code: data.roleCode, permissions: data.rolePermissions.split(/[,，]/).map(item => item.trim()).filter(Boolean) });
      await saveState("role.create", data.roleCode, "新增角色");
    }
    if (kind === "asset-import") {
      if (!Array.isArray(state.assets)) state.assets = [];
      const rows = parseRows(data.assetImport).map(row => ({ id: row.id || uid("asset"), code: row.code || `AS-${Date.now()}`, name: row.name || "未命名资产", category: row.category || "未分类", location: row.location || "未设置", owner: row.owner || "未设置", status: row.status || "PENDING_INSPECTION", qr: row.qr || row.code || uid("qr") }));
      state.assets.unshift(...rows);
      await saveState("asset.import", "assets", `批量导入 ${rows.length} 条资产`);
    }
    if (kind === "asset-transfer") {
      const asset = assets().find(item => item.id === data.transferAsset);
      if (asset) {
        asset.location = data.transferLocation;
        asset.owner = data.transferOwner;
        asset.updatedAt = nowText();
        await saveState("asset.transfer", asset.code, `调拨至 ${data.transferLocation}`);
      }
    }
    if (kind === "asset-depreciation") {
      const asset = assets().find(item => item.id === data.assetId);
      if (asset) {
        asset.originalValue = Number(data.originalValue || asset.originalValue || asset.price || 5000);
        if (data.depreciationValue === "") delete asset.depreciationValue;
        else asset.depreciationValue = Number(data.depreciationValue);
        asset.updatedAt = nowText();
        await saveState("asset.depreciation", asset.code, data.depreciationValue === "" ? "改为自动折旧估值" : `手动估值 ${data.depreciationValue}`);
      }
    }
    if (kind === "inspection-assign") {
      const plan = (state.plans || []).find(item => item.id === data.planId);
      if (plan) {
        plan.inspector = data.planInspector;
        plan.nextDate = data.planNextDate;
        await saveState("inspection.assign", plan.id, `分配给 ${data.planInspector}`);
      }
    }
    if (kind === "order-update") {
      const order = orders().find(item => item.id === data.orderId);
      if (order) {
        order.category = data.orderCategory || order.category;
        order.priority = data.orderPriority;
        order.laborHours = Number(data.orderHours || 0);
        order.updatedAt = nowText();
        await saveState("order.update", order.code || order.id, "维护分类、优先级和工时");
      }
    }
    if (kind === "template-create") {
      state.templates.unshift({ id: uid("tpl"), title: data.tplTitle, category: data.tplCategory || "未分类", priority: data.tplPriority, content: data.tplContent });
      await saveState("template.create", data.tplTitle, "新增工单模板");
    }
    if (kind === "settings-save") {
      state.settings.systemName = data.systemName;
      state.settings.backupCycle = data.backupCycle;
      state.settings.notifyEmail = data.channels.includes("邮件");
      state.settings.notifySms = data.channels.includes("短信");
      await saveState("settings.update", "system", "保存系统设置");
    }
    if (kind === "dict-save") {
      state.dictionaries = JSON.parse(data.dictJson);
      await saveState("dictionary.update", "dictionaries", "保存数据字典");
    }
    renderPanel();
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    if (action === "close") $(".db-admin-mask").classList.remove("open");
    if (action === "asset-search") {
      sessionStorage.setItem("asset-filter", $("#assetSearch")?.value || "");
      sessionStorage.setItem("asset-status-filter", $("#assetStatusFilter")?.value || "");
      sessionStorage.setItem("asset-category-filter", $("#assetCategoryFilter")?.value || "");
      sessionStorage.setItem("asset-min-value", $("#assetMinValue")?.value || "");
      sessionStorage.setItem("asset-max-value", $("#assetMaxValue")?.value || "");
    }
    if (action === "asset-detail") sessionStorage.setItem("asset-detail-id", button.dataset.id || "");
    if (action === "order-search") {
      sessionStorage.setItem("order-filter", $("#orderSearch")?.value || "");
      sessionStorage.setItem("order-status-filter", $("#orderStatusFilter")?.value || "");
      sessionStorage.setItem("order-priority-filter", $("#orderPriorityFilter")?.value || "");
    }
    if (action === "order-fill-edit") {
      const order = orders().find(item => item.id === button.dataset.id);
      if (order) {
        const form = document.querySelector('[data-form="order-update"]');
        form.elements.orderId.value = order.id;
        form.elements.orderCategory.value = order.category || "";
        form.elements.orderPriority.value = order.priority || "中";
        form.elements.orderHours.value = order.laborHours || 0;
      }
      return;
    }
    if (action === "toggle-asset-check") document.querySelectorAll("[data-asset-check]").forEach(input => { input.checked = button.checked; });
    if (action === "asset-export-csv") location.href = "/api/export?collection=assets&format=csv";
    if (action === "order-export-csv") location.href = `/api/export?collection=${state.workOrders ? "workOrders" : "orders"}&format=csv`;
    if (action === "asset-print-tags") printAssetTags();
    if (action === "asset-delete-selected") {
      const ids = [...document.querySelectorAll("[data-asset-check]:checked")].map(input => input.value);
      if (!ids.length) return toast("请先选择资产");
      if (!confirmAction(`确认删除选中的 ${ids.length} 条资产吗？`)) return;
      state.assets = assets().filter(asset => !ids.includes(asset.id));
      await saveState("asset.batchDelete", "assets", `批量删除 ${ids.length} 条资产`);
    }
    if (action === "user-reset") {
      if (!confirmAction("确认将该用户密码重置为 123456 吗？")) return;
      const user = state.users.find(item => item.id === button.dataset.id);
      if (user) user.password = "123456";
      await saveState("user.resetPassword", user?.username, "重置密码");
    }
    if (action === "user-toggle") {
      const user = state.users.find(item => item.id === button.dataset.id);
      if (user) user.status = user.status === "disabled" ? "enabled" : "disabled";
      await saveState("user.toggle", user?.username, "切换用户状态");
    }
    if (action === "user-delete") {
      if (!confirmAction("确认删除该用户吗？")) return;
      state.users = state.users.filter(item => item.id !== button.dataset.id);
      await saveState("user.delete", button.dataset.id, "删除用户");
    }
    if (action === "role-delete") {
      const role = state.roles.find(item => item.id === button.dataset.id);
      if (role?.code === "dba") return toast("不能删除数据库管理员角色");
      if (!confirmAction("确认删除该角色吗？")) return;
      state.roles = state.roles.filter(item => item.id !== button.dataset.id || item.code === "dba");
      await saveState("role.delete", button.dataset.id, "删除角色");
    }
    if (action === "export-json" || action === "export-csv" || action === "export-pdf") {
      const format = action.replace("export-", "").replace("json", "json");
      location.href = `/api/export?collection=${$("#exportCollection").value}&format=${format}`;
    }
    if (action === "backup-create") {
      await fetch("/api/backups", { method: "POST" });
      await refreshBackups();
      toast("备份已创建");
    }
    if (action === "backup-refresh") await refreshBackups();
    if (action === "backup-restore") {
      if (!confirmAction("确认恢复选中的备份吗？当前数据会被覆盖。")) return;
      await fetch("/api/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: $("#backupFile").value }) });
      await loadState();
      toast("备份已恢复");
    }
    if (action === "metrics-refresh") await refreshMetrics();
    if (action === "undo-last") {
      if (!confirmAction("确认撤销上一次管理员保存吗？")) return;
      const previous = localStorage.getItem("campus-db-admin-undo");
      if (previous) {
        state = JSON.parse(previous);
        await saveState("system.undo", "state", "撤销上一次管理员保存");
      }
    }
    renderPanel();
  }

  function enhanceAssetLogin() {
    const panel = document.querySelector(".login-panel");
    if (!panel || panel.querySelector(".upgrade-login-box") || !document.querySelector("[data-login]")) return;
    const remembered = readJsonStorage(assetLoginKey);
    const rememberedUsername = isFreshSession(remembered) ? remembered.username : "admin";
    const rememberedPassword = isFreshSession(remembered) ? (remembered.password || defaultPasswordFor(rememberedUsername)) : "admin123";
    const box = document.createElement("div");
    box.className = "upgrade-login-box";
    box.innerHTML = `
      <strong>账号密码验证</strong>
      <p class="db-muted">演示账号：admin/admin123、inspector/inspect123、worker/worker123、reporter/user123、dbadmin/dbadmin123。</p>
      <div class="db-row">
        <label>账号<input id="assetLoginUser" value="${esc(rememberedUsername)}" autocomplete="username"></label>
        <label>密码<input id="assetLoginPass" type="password" value="${esc(rememberedPassword)}" autocomplete="current-password"></label>
      </div>
      <div class="upgrade-login-error" id="assetLoginError"></div>
    `;
    const roleList = panel.querySelector(".role-list");
    panel.insertBefore(box, roleList);
  }

  function validateAssetRoleLogin(role) {
    const userName = $("#assetLoginUser")?.value.trim();
    const pass = $("#assetLoginPass")?.value.trim();
    const defaults = [
      { username: "admin", password: "admin123", role: "admin" },
      { username: "inspector", password: "inspect123", role: "inspector" },
      { username: "worker", password: "worker123", role: "worker" },
      { username: "reporter", password: "user123", role: "reporter" },
      { username: "dbadmin", password: "dbadmin123", role: "dba" }
    ];
    const accounts = [...defaults, ...state.users];
    const user = accounts.find(item => item.username === userName && item.password === pass);
    if (!user || user.status === "disabled" || ![role, "dba"].includes(user.role)) {
      const error = $("#assetLoginError");
      if (error) error.textContent = "账号、密码或所选角色不匹配。";
      return false;
    }
    localStorage.setItem(assetLoginKey, JSON.stringify({ username: user.username, role: user.role, name: user.name || user.username, password: pass, time: Date.now() }));
    return true;
  }

  function validateWorkorderLogin(event) {
    const form = event.target.closest("#loginForm");
    if (!form || form.dataset.upgradeChecked === "true") return;
    const username = form.elements.username?.value.trim();
    const password = form.elements.password?.value.trim();
    const role = form.elements.role?.value;
    if (username === "admin" && password === "123456") return;

    const defaults = [
      { username: "admin", password: "123456", role: "admin" },
      { username: "worker", password: "123456", role: "worker" },
      { username: "reporter", password: "123456", role: "reporter" },
      { username: "ai", password: "123456", role: "ai" },
      { username: "dbadmin", password: "dbadmin123", role: "dba" }
    ];
    const user = [...defaults, ...state.users].find(item => item.username === username && item.password === password && item.status !== "disabled");
    if (!user || ![role, "dba", "admin"].includes(user.role)) {
      return;
    }
    form.dataset.upgradeChecked = "true";
    form.elements.username.value = "admin";
    form.elements.password.value = "123456";
  }

  function install() {
    const launch = document.createElement("button");
    launch.className = "db-admin-launch";
    launch.textContent = "数据库管理员";
    launch.addEventListener("click", async () => {
      await loadState();
      await refreshBackups().catch(() => {});
      renderPanel();
      $(".db-admin-mask").classList.add("open");
    });
    const mask = document.createElement("div");
    mask.className = "db-admin-mask";
    document.body.append(launch, mask);

    document.addEventListener("submit", event => {
      validateWorkorderLogin(event);
      const form = event.target.closest("[data-form]");
      if (!form) return;
      event.preventDefault();
      handleForm(form).catch(error => toast(error.message));
    });

    document.addEventListener("click", event => {
      const tab = event.target.closest("[data-tab]");
      if (tab) {
        activeTab = tab.dataset.tab;
        renderPanel();
        return;
      }
      const button = event.target.closest("[data-action]");
      if (button) handleAction(button).catch(error => toast(error.message));
    });

    document.addEventListener("change", event => {
      const input = event.target.closest("[data-photo-upload]");
      if (!input || !input.files?.[0]) return;
      const record = (state.inspections || []).find(item => item.id === $("#photoInspection")?.value);
      const reader = new FileReader();
      reader.onload = async () => {
        if (record) {
          record.photo = reader.result;
          await saveState("inspection.photo", record.id, "上传现场图片");
          renderPanel();
        }
      };
      reader.readAsDataURL(input.files[0]);
    });

    document.addEventListener("click", event => {
      const roleButton = event.target.closest("[data-login]");
      if (!roleButton || !document.querySelector(".upgrade-login-box")) return;
      if (!validateAssetRoleLogin(roleButton.dataset.login)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    const observer = new MutationObserver(enhanceAssetLogin);
    observer.observe(document.body, { childList: true, subtree: true });
    loadState().then(enhanceAssetLogin).catch(() => {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();
