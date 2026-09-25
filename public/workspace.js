"use strict";

const $ = selector => document.querySelector(selector);
const state = { projects: [], next: 0, id: null, project: null, brief: null, history: [],
  historyNext: 0, view: "brief", generation: 0, listGeneration: 0, historyGeneration: 0, saving: false, editor: null,
  projectsLoaded: false, projectsLoading: false, projectsError: null, projectsUpdatedAt: null };
const { labels, sections, toMarkdown } = window.BriefFormat;

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function icon(name) { const node = el("i"); node.dataset.lucide = name; node.setAttribute("aria-hidden", "true"); return node; }
function icons() { window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } }); }
function button(label, name, action, className = "icon-button") {
  const node = el("button", className);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.title = label;
  if (name) node.append(icon(name));
  if (className !== "icon-button") node.append(el("span", "", label));
  node.addEventListener("click", action);
  return node;
}
function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", year: "numeric", hour12: false,
  }).format(parsed);
}
function errorText(error) {
  const messages = { 400: "内容未通过校验，请检查字段长度、日期和来源。", 403: "此请求不允许从外部网页发起。",
    404: "项目或原记录不存在，请刷新后检查。", 409: "这条记录已被更新。草稿已保留，请关闭表单并刷新历史后重新更正。",
    413: "内容过长，请缩短后提交。", 503: "数据库暂时不可用，请稍后重试。" };
  return (messages[error.status] || "连接失败，请检查本地服务后重试。")
    + (error.requestId ? ` 请求编号：${error.requestId}` : "");
}
async function api(route, body) {
  const response = await fetch(route, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Object.assign(new Error("Request failed"), { status: response.status, requestId: response.headers.get("x-request-id") });
  return response.json();
}
let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 5500);
}
function showError(selector, error) { const node = $(selector); node.textContent = errorText(error); node.hidden = false; }
function toggleNav(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#sidebar-backdrop").hidden = !open;
  $("#open-nav").setAttribute("aria-expanded", String(open));
  $("#sidebar").inert = !open && matchMedia("(max-width:780px)").matches;
  $(".shell").inert = open && matchMedia("(max-width:780px)").matches;
  if (open) $("#project-search").focus();
}
function navigate(id, view = "brief") {
  const next = `project=${id}&view=${view}`;
  if (location.hash.slice(1) === next) { loadProject(id, view); return; }
  location.hash = next;
}
async function loadProjects(append = false) {
  if (append && (state.projectsLoading || state.next === null)) return;
  const generation = ++state.listGeneration;
  const offset = append ? state.next : 0;
  state.projectsLoading = true; state.projectsError = null;
  $("#more-projects").disabled = true;
  $("#projects-error").hidden = true;
  renderOverview();
  try {
    const data = await api(`/projects?limit=50&offset=${offset}`);
    if (generation !== state.listGeneration) return;
    state.projects = append ? [...new Map([...state.projects, ...data.projects].map(p => [p.id, p])).values()] : data.projects;
    state.next = data.next_offset;
    state.projectsLoaded = true; state.projectsUpdatedAt = new Date().toISOString();
    renderProjects();
  } catch (error) {
    if (generation === state.listGeneration) {
      state.projectsError = error;
      showError("#projects-error", error);
      $("#projects-error").append(button("重试", "refresh-cw", () => loadProjects(append), "text-button"));
    }
  } finally {
    if (generation === state.listGeneration) {
      state.projectsLoading = false;
      $("#more-projects").disabled = false;
      renderOverview();
    }
  }
}
function renderProjects() {
  if (!state.id) $("#overview-nav").setAttribute("aria-current", "page");
  else $("#overview-nav").removeAttribute("aria-current");
  const container = $("#project-list"); container.replaceChildren();
  const term = $("#project-search").value.trim().toLocaleLowerCase();
  const projects = state.projects.filter(p => p.name.toLocaleLowerCase().includes(term));
  for (const project of projects) {
    const node = button(project.name, "folder", () => { navigate(project.id); toggleNav(false); }, "project-link");
    node.replaceChildren(icon("folder"));
    node.classList.toggle("active", project.id === state.id);
    if (project.id === state.id) node.setAttribute("aria-current", "page");
    const copy = el("span");
    copy.append(el("strong", "", project.name), el("small", "", `${labels.project[project.status]} · ${project.open_actions ?? 0} 待办 · ${project.open_blockers ?? 0} 阻塞`));
    node.append(copy); container.append(node);
  }
  if (!projects.length) container.append(el("p", "section-empty", term ? "已加载项目中没有匹配结果" : "还没有项目"));
  $("#more-projects").hidden = state.next === null;
  icons();
}
function showOverview() {
  ++state.generation; ++state.historyGeneration;
  state.id = null; state.project = null; state.brief = null; state.history = []; state.view = "overview";
  $("#project-view").hidden = true; $("#loading").hidden = true; $("#page-error").hidden = true;
  $("#breadcrumb-name").textContent = "项目总览";
  renderProjects(); renderOverview();
}
function projectCount(project, key) {
  const value = project[key];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function renderOverview() {
  if (state.id) return;
  const empty = state.projectsLoaded && !state.projects.length && !state.projectsError && !state.projectsLoading;
  $("#welcome").hidden = !empty; $("#overview-view").hidden = empty;
  $("#overview-view").setAttribute("aria-busy", String(state.projectsLoading));
  $("#overview-scope").textContent = state.projectsLoaded
    ? `已加载 ${state.projects.length} 个项目${state.next !== null ? " · 还有更多项目未加载" : " · 已全部加载"} · 列表更新 ${date(state.projectsUpdatedAt)}${state.projectsLoading ? " · 正在更新…" : ""}`
    : state.projectsLoading ? "正在加载项目…" : "尚未加载项目";
  $("#overview-error").hidden = !state.projectsError;
  if (state.projectsError) {
    showError("#overview-error", state.projectsError);
    if (state.projectsLoaded) $("#overview-error").append(document.createTextNode(" 显示上次已加载的数据，尚未刷新成功。"));
    $("#overview-error").append(button("重新加载项目", "refresh-cw", () => loadProjects(), "text-button"));
  }
  $("#overview-stats").hidden = !state.projectsLoaded;
  $("#overview-controls").hidden = !state.projectsLoaded;
  $("#overview-more").hidden = !state.projectsLoaded || state.next === null;
  $("#overview-more").disabled = state.projectsLoading;
  const stats = $("#overview-stats"); stats.replaceChildren();
  const metrics = [["open_actions", "未完成待办", "list-todo"], ["open_blockers", "未解决阻塞", "circle-alert"], ["unverified_entries", "待确认记录", "circle-help"]];
  for (const [key, label, symbol] of metrics) {
    const values = state.projects.map(project => projectCount(project, key));
    const total = values.some(value => value === null) ? "未知" : values.reduce((sum, value) => sum + value, 0);
    const stat = el("div", "overview-stat"); stat.dataset.metric = key;
    const heading = el("div", "overview-stat-label"); heading.append(icon(symbol), document.createTextNode(label));
    stat.append(heading, el("strong", "overview-stat-value", total), el("small", "", key === "unverified_entries" ? "当前记录 · 不含有争议" : "当前记录 · 含待确认和有争议"));
    stats.append(stat);
  }
  const term = $("#overview-search").value.trim().toLocaleLowerCase(), status = $("#overview-status").value;
  const projects = state.projects.filter(project => project.name.toLocaleLowerCase().includes(term)
    && (status === "all" || project.status === status));
  const order = $("#overview-sort").value;
  projects.sort((a, b) => {
    const name = a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id);
    if (order === "name") return name;
    const recent = (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0);
    if (order === "updated") return recent || name;
    const key = order === "blockers" ? "open_blockers" : "open_actions";
    return (projectCount(b, key) ?? -1) - (projectCount(a, key) ?? -1) || recent || name;
  });
  $("#overview-result-count").textContent = state.projectsLoaded ? `${projects.length} / ${state.projects.length} 个已加载项目` : "";
  const container = $("#overview-list"); container.replaceChildren();
  if (state.projectsLoaded && !projects.length) container.append(el("p", "section-empty", "已加载项目中没有匹配结果"));
  for (const project of projects) {
    const card = el("article", "overview-project"); card.dataset.projectId = project.id;
    const header = el("div", "overview-project-heading"), heading = el("h3"), link = el("a", "overview-project-link", project.name);
    link.href = `#project=${project.id}&view=brief`; link.append(icon("arrow-up-right")); heading.append(link);
    header.append(heading, badge(labels.project[project.status] || "未知", project.status === "active" ? "green" : ""));
    const counts = el("dl", "overview-project-counts");
    for (const [key, label] of metrics) {
      const group = el("div"); group.dataset.metric = key;
      group.append(el("dt", "", label), el("dd", "", projectCount(project, key) ?? "未知")); counts.append(group);
    }
    card.append(header, el("p", "overview-objective", project.objective), counts,
      el("p", "subtle overview-updated", "最后更新 " + date(project.updated_at)));
    container.append(card);
  }
  icons();
}
async function loadProject(id, view = state.view) {
  const generation = ++state.generation;
  state.id = id; state.project = null; state.brief = null; state.history = []; state.historyNext = 0;
  $("#page-error").hidden = true; $("#project-view").hidden = true; $("#overview-view").hidden = true; $("#welcome").hidden = true; $("#loading").hidden = false;
  renderProjects();
  try {
    const brief = await api(`/projects/${id}/brief`);
    if (generation !== state.generation) return;
    state.project = brief.project; state.brief = brief;
    $("#project-name").textContent = brief.project.name;
    $("#breadcrumb-name").textContent = brief.project.name;
    $("#project-objective").textContent = brief.project.objective;
    $("#project-status").textContent = labels.project[brief.project.status];
    $("#project-status").className = `badge ${brief.project.status === "active" ? "green" : ""}`;
    $("#snapshot-time").textContent = "快照 " + date(brief.generated_at);
    renderBrief(); renderInfo();
    $("#project-view").hidden = false;
    selectTab(view);
  } catch (error) {
    if (generation === state.generation) {
      showError("#page-error", error);
      $("#page-error").append(button("重新加载", "refresh-cw", () => loadProject(id, view), "text-button"));
    }
  } finally { if (generation === state.generation) $("#loading").hidden = true; }
}
function badge(label, color = "") { return el("span", `badge ${color}`, label); }
function sourceDetails(record, compact = true) {
  const source = record.source || {};
  const definition = el("dl", "source-detail");
  const values = [["来源", `${labels.source[source.kind] || "其他"} · ${source.label || "未注明"}`],
    ["采集时间", date(source.captured_at)], ["发生时间", date(record.occurred_at || record.created_at)],
    ["记录时间", date(record.created_at)]];
  for (const [key, value] of values) definition.append(el("dt", "", key), el("dd", "", value));
  if (source.locator) {
    const cell = el("dd");
    let link;
    try { const url = new URL(source.locator); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) link = url.href; } catch { /* Non-URL source references remain plain text. */ }
    if (link) {
      const anchor = el("a", "", source.locator); anchor.href = link; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; cell.append(anchor);
    } else cell.textContent = source.locator;
    definition.append(el("dt", "", "位置"), cell);
  }
  if (!compact) return definition;
  const details = el("details", "entry-meta");
  details.append(el("summary", "", `${source.label || "未注明来源"} · ${date(record.created_at)}`), definition);
  return details;
}
function renderEntry(record, history = false) {
  const current = record.is_current !== false;
  const node = el("article", `entry ${current ? "" : "superseded"}`);
  node.dataset.entryId = record.id;
  const tags = el("div", "entry-tags");
  tags.append(badge(labels.kind[record.kind]), badge(labels.verification[record.verification],
    record.verification === "confirmed" ? "green" : record.verification === "disputed" ? "red" : "amber"));
  if (record.status !== "recorded") tags.append(badge(labels.status[record.status], "blue"));
  if (history && !current) tags.append(badge("已被更正"));
  if (history && record.supersedes_id) tags.append(badge("更正记录"));
  if (record.owner_ref) tags.append(el("span", "subtle", record.owner_ref));
  const heading = el("div", "entry-head"), controls = el("div", "entry-commands");
  heading.append(el("p", "entry-content", record.content));
  if (current) {
    if (record.kind === "action" && ["todo", "doing"].includes(record.status)) controls.append(button("完成", "check", () => openEditor("entry", record, "done"), "text-button"));
    if (record.kind === "blocker" && record.status === "open") controls.append(button("解决", "check", () => openEditor("entry", record, "resolved"), "text-button"));
    controls.append(button("更正记录", "pencil", () => openEditor("entry", record)));
    heading.append(controls);
  }
  node.append(tags, heading, sourceDetails(record));
  return node;
}
function renderBrief() {
  const brief = state.brief; const stats = $("#stats"); stats.replaceChildren();
  for (const [key, label, name] of [["next_actions", "已确认待办", "list-todo"], ["blockers", "已确认阻塞", "circle-alert"], ["unverified", "待确认信息", "circle-help"]]) {
    const stat = el("div", "stat"), symbol = el("span", "stat-icon"), copy = el("div");
    symbol.append(icon(name)); copy.append(el("div", "stat-value", brief.sections[key].total), el("div", "stat-label", label));
    stat.append(symbol, copy); stats.append(stat);
  }
  const container = $("#brief-sections"); container.replaceChildren();
  for (const [key, title, name] of sections) {
    const section = brief.sections[key];
    const node = el("section", "context-section" + (key === "closed" ? " full" : "")); node.dataset.section = key;
    const heading = el("div", "section-heading"), label = el("h2");
    label.append(icon(name), document.createTextNode(title), el("span", "count", String(section.total)));
    heading.append(label); node.append(heading);
    if (!section.entries.length) {
      const empty = el("p", "section-empty"); empty.append(icon("minus"), document.createTextNode("暂无相关记录")); node.append(empty);
    }
    for (const entry of section.entries) node.append(renderEntry(entry));
    if (section.truncated) {
      node.append(el("p", "truncated", `显示最近 ${section.entries.length} 条，共 ${section.total} 条`),
        button("查看记录历史", "arrow-right", () => navigate(state.id, "history"), "text-button"));
    }
    container.append(node);
  }
  icons();
}
function renderInfo() {
  const project = state.project, container = $("#project-info"); container.replaceChildren();
  for (const [title, content] of [["项目目标", project.objective], ["项目约束", project.constraints]]) {
    const section = el("section", "info-section"); section.append(el("h2", "", title));
    if (Array.isArray(content)) {
      const list = el("ul"); for (const value of content) list.append(el("li", "", value));
      section.append(content.length ? list : el("p", "subtle", "未记录约束"));
    } else section.append(el("p", "", content));
    container.append(section);
  }
  const details = el("section", "info-section"); details.append(el("h2", "", "项目信息来源"), sourceDetails(project, false)); container.append(details);
}
async function loadHistory(append = false) {
  const generation = state.generation, id = state.id, historyGeneration = ++state.historyGeneration;
  $("#history-error").hidden = true; $("#more-history").disabled = true;
  if (!append) { $("#history-list").replaceChildren(el("p", "section-empty", "正在读取历史…")); state.history = []; }
  try {
    const data = await api(`/projects/${id}/entries?limit=50&offset=${append ? state.historyNext : 0}`);
    if (generation !== state.generation || historyGeneration !== state.historyGeneration) return;
    state.history = append ? [...new Map([...state.history, ...data.entries].map(r => [r.id, r])).values()] : data.entries;
    state.historyNext = data.next_offset;
    $("#history-list").replaceChildren(...state.history.map(row => renderEntry(row, true)));
    if (!state.history.length) $("#history-list").append(el("p", "section-empty", "还没有记录"));
    $("#history-count").textContent = `已加载 ${state.history.length} 条`;
    $("#more-history").hidden = !data.has_more;
    icons();
  } catch (error) {
    if (generation === state.generation && historyGeneration === state.historyGeneration) {
      showError("#history-error", error);
      if (!append) $("#history-list").replaceChildren();
      $("#history-error").append(button("重试", "refresh-cw", () => loadHistory(append), "text-button"));
    }
  } finally { if (generation === state.generation && historyGeneration === state.historyGeneration) $("#more-history").disabled = false; }
}
function selectTab(view) {
  state.view = ["brief", "history", "info"].includes(view) ? view : "brief";
  for (const name of ["brief", "history", "info"]) {
    const active = name === state.view;
    $(`#tab-${name}`).setAttribute("aria-selected", String(active)); $(`#tab-${name}`).tabIndex = active ? 0 : -1;
    $(`#panel-${name}`).hidden = !active;
  }
  if (state.view === "history" && !state.history.length) loadHistory();
}
function route() {
  const params = new URLSearchParams(location.hash.slice(1)), id = params.get("project"), view = params.get("view") || "brief";
  if (id && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
    if (state.id === id && state.brief) selectTab(view); else loadProject(id, view);
  } else showOverview();
}
const form = $("#editor-form"), field = name => form.elements.namedItem(name);
function updateStatuses(value) {
  const kind = field("kind").value;
  const statuses = kind === "action" ? ["todo", "doing", "done", "cancelled"] : kind === "blocker" ? ["open", "resolved"] : ["recorded"];
  field("status").replaceChildren(...statuses.map(status => { const node = el("option", "", labels.status[status]); node.value = status; return node; }));
  if (value && statuses.includes(value)) field("status").value = value;
}
function sourceTypeChanged() { field("source_locator").required = field("source_kind").value === "url"; }
function openEditor(mode, record = null, nextStatus = null) {
  if (mode === "entry" && !state.project) return;
  form.reset(); state.editor = { mode, projectId: state.id, record };
  $("#save-editor").disabled = false;
  $("#form-error").hidden = true;
  $("#editor-title").textContent = mode === "project" ? "新建项目" : record ? nextStatus === "done" ? "完成待办" : nextStatus === "resolved" ? "解决阻塞" : "更正记录" : "添加记录";
  $("#editor-context").textContent = mode === "project" ? "我的项目" : state.project.name;
  for (const [id, enabled] of [["project-fields", mode === "project"], ["entry-fields", mode === "entry"]]) {
    $(`#${id}`).hidden = !enabled;
    for (const input of $(`#${id}`).querySelectorAll("input,textarea,select")) input.disabled = !enabled;
  }
  field("name").required = mode === "project"; field("objective").required = mode === "project";
  field("content").required = mode === "entry";
  if (mode === "entry") {
    field("kind").value = record?.kind || "progress"; field("kind").disabled = Boolean(record);
    updateStatuses(nextStatus || record?.status);
    field("content").value = record?.content || ""; field("owner_ref").value = record?.owner_ref || "";
    field("verification").value = "unverified";
  }
  sourceTypeChanged();
  $("#editor").showModal();
  state.editor.initial = formSnapshot();
  field(mode === "project" ? "name" : "content").focus();
}
function formSnapshot() { return JSON.stringify([...new FormData(form)]); }
function closeEditor(force = false) {
  if (state.saving) return;
  if (!force && state.editor && state.editor.initial !== formSnapshot() && !window.confirm("放弃尚未保存的内容？")) return;
  $("#editor").close(); state.editor = null;
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (state.saving || state.editor?.uncertain) return;
  const { mode, projectId, record } = state.editor;
  const read = name => field(name).value.trim();
  let body;
  try {
    const source = { kind: read("source_kind"), label: read("source_label") };
    if (read("source_locator")) source.locator = read("source_locator");
    if (source.kind === "url") {
      const url = new URL(source.locator);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw Error("来源需要不含账号密码的 HTTP 或 HTTPS 地址。");
    }
    if (mode === "project") body = { name: read("name"), objective: read("objective"),
      constraints: read("constraints").split(/\r?\n/).map(s => s.trim()).filter(Boolean), source };
    else {
      body = { kind: read("kind"), content: read("content"), status: read("status"), verification: read("verification"), source };
      if (read("owner_ref")) body.owner_ref = read("owner_ref");
      if (record) body.supersedes_id = record.id;
      if (read("occurred_at")) body.occurred_at = new Date(read("occurred_at")).toISOString();
    }
  } catch {
    $("#form-error").textContent = "请检查日期及来源地址。网页来源必须使用不含账号密码的 HTTP 或 HTTPS 地址。";
    $("#form-error").hidden = false; return;
  }
  const enabled = [...form.querySelectorAll("input,textarea,select")].filter(input => !input.disabled);
  for (const input of enabled) input.disabled = true;
  state.saving = true; $("#save-editor").disabled = true; $("#cancel-editor").disabled = true; $("#close-editor").disabled = true;
  $("#save-editor span").textContent = "保存中…"; $("#form-error").hidden = true;
  let saved;
  try { saved = await api(mode === "project" ? "/projects" : `/projects/${projectId}/entries`, body); }
  catch (error) {
    showError("#form-error", error);
    state.editor.uncertain = !error.status || error.status >= 500 || error.status === 409;
    if (!error.status || error.status >= 500) $("#form-error").append(document.createTextNode(" 保存结果可能尚未确认，请先关闭表单并刷新历史，核对是否已有记录，再决定是否重试。"));
    return;
  } finally {
    for (const input of enabled) input.disabled = false;
    state.saving = false; $("#save-editor").disabled = Boolean(state.editor.uncertain); $("#cancel-editor").disabled = false; $("#close-editor").disabled = false;
    $("#save-editor span").textContent = "保存";
  }
  closeEditor(true); toast(mode === "project" ? "项目已创建" : "记录已保存");
  if (mode === "project") navigate(saved.id);
  else if (state.id === projectId) await loadProject(projectId, state.view);
  await loadProjects();
});
$("#editor").addEventListener("cancel", event => { event.preventDefault(); closeEditor(); });
$("#close-editor").addEventListener("click", () => closeEditor());
$("#cancel-editor").addEventListener("click", () => closeEditor());
field("kind").addEventListener("change", () => updateStatuses());
field("source_kind").addEventListener("change", sourceTypeChanged);
$("#new-project").addEventListener("click", () => { toggleNav(false); openEditor("project"); });
$("#welcome-create").addEventListener("click", () => openEditor("project"));
$("#overview-create").addEventListener("click", () => openEditor("project"));
$("#overview-nav").addEventListener("click", () => toggleNav(false));
$("#overview-search").addEventListener("input", renderOverview);
$("#overview-status").addEventListener("change", renderOverview);
$("#overview-sort").addEventListener("change", renderOverview);
$("#overview-more").addEventListener("click", () => loadProjects(true));
$("#new-entry").addEventListener("click", () => openEditor("entry"));
$("#refresh").addEventListener("click", async () => { if (state.id) await loadProject(state.id, state.view); await loadProjects(); });
$("#project-search").addEventListener("input", renderProjects);
$("#more-projects").addEventListener("click", () => loadProjects(true));
$("#more-history").addEventListener("click", () => loadHistory(true));
$("#open-nav").addEventListener("click", () => toggleNav(true));
$("#close-nav").addEventListener("click", () => { toggleNav(false); $("#open-nav").focus(); });
$("#sidebar-backdrop").addEventListener("click", () => toggleNav(false));
document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("#editor").open) toggleNav(false); });
for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => navigate(state.id, tab.dataset.tab));
  tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const tabs = [...document.querySelectorAll("[data-tab]")];
    const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === "ArrowLeft" ? 2 : 1)) % tabs.length;
    tabs[index].focus(); tabs[index].click();
  });
}
function downloadBrief(text, type, filename) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const copyPreview = $("#copy-preview");
let pendingMarkdown = null;
$("#copy-brief").addEventListener("click", async () => {
  if (!state.brief) return;
  const brief = state.brief, generation = state.generation;
  let markdown;
  try { markdown = toMarkdown(brief); }
  catch { toast("简报生成失败，请刷新项目后重试。"); return; }
  $("#copy-brief").disabled = true;
  try {
    await navigator.clipboard.writeText(markdown);
    toast(`已复制「${brief.project.name}」交接简报`);
  } catch {
    if (generation !== state.generation) return;
    pendingMarkdown = { text: markdown, id: brief.project.id };
    $("#copy-project-name").textContent = brief.project.name;
    $("#copy-text").value = markdown;
    copyPreview.showModal();
    $("#copy-text").focus();
    $("#copy-text").select();
  } finally { $("#copy-brief").disabled = false; }
});
copyPreview.addEventListener("close", () => {
  pendingMarkdown = null;
  $("#copy-text").value = "";
  $("#copy-project-name").textContent = "";
});
$("#close-copy-preview").addEventListener("click", () => copyPreview.close());
$("#select-copy-text").addEventListener("click", () => { $("#copy-text").focus(); $("#copy-text").select(); });
$("#download-markdown").addEventListener("click", () => {
  if (pendingMarkdown) downloadBrief(pendingMarkdown.text, "text/markdown; charset=utf-8", `project-brief-${pendingMarkdown.id}.md`);
});
$("#export-brief").addEventListener("click", () => {
  if (state.brief) downloadBrief(JSON.stringify(state.brief, null, 2), "application/json", `project-brief-${state.id}.json`);
});
window.addEventListener("hashchange", route);
matchMedia("(max-width:780px)").addEventListener("change", () => toggleNav(false));
toggleNav(false);
icons(); route(); loadProjects();
