const { createServer } = require("../app");
const { randomUUID } = require("node:crypto");

const projectId = "12345678-1234-4123-8123-123456789abc";
const now = "2026-09-25T00:00:00.000Z";
const project = { id: projectId, name: "网站发布", objective: "把审阅后的首页发布出去", constraints: ["只使用 JavaScript", "先完成移动端检查"],
  source: { kind: "note", label: "项目启动记录", captured_at: now }, status: "active", created_at: now, updated_at: now };
const entries = [{ id: "22345678-1234-4123-8123-123456789abc", project_id: projectId, kind: "action", content: "检查首页移动端表现", verification: "confirmed", status: "todo", owner_ref: "项目负责人", source: { kind: "note", label: "迭代计划", captured_at: now }, occurred_at: now, created_at: now, supersedes_id: null, is_current: true }];

function sections() {
  const current = entries.filter(entry => entry.is_current);
  const values = { confirmed_facts: [], decisions: [], blockers: [], next_actions: [], unverified: [], disputed: [], closed: [] };
  for (const entry of current) {
    const key = entry.verification !== "confirmed" ? entry.verification : entry.kind === "progress" ? "confirmed_facts"
      : entry.kind === "decision" ? "decisions" : entry.kind === "blocker" ? (entry.status === "open" ? "blockers" : "closed")
      : ["todo", "doing"].includes(entry.status) ? "next_actions" : "closed";
    values[key].push({ ...entry });
  }
  return Object.fromEntries(Object.entries(values).map(([key, records]) => [key, { entries: records, total: records.length, truncated: false }]));
}
const database = {
  async listProjects() { return { projects: [{ ...project, open_actions: entries.filter(e => e.is_current && e.kind === "action" && ["todo", "doing"].includes(e.status)).length, open_blockers: 0, unverified_entries: entries.filter(e => e.is_current && e.verification === "unverified").length }], limit: 50, offset: 0, has_more: false, next_offset: null }; },
  async getProject(id) { return id === projectId ? project : null; },
  async getProjectBrief(id) { return id === projectId ? { project, generated_at: now, mode: "recorded_context", verification_basis: "caller_asserted", sections: sections() } : null; },
  async listProjectEntries(id) { return id === projectId ? { entries: entries.map(entry => ({ ...entry })), limit: 50, offset: 0, has_more: false, next_offset: null } : null; },
  async createProject(input) { const created = { ...project, id: randomUUID(), name: input.name, objective: input.objective, constraints: input.constraints, source: input.source }; return created; },
  async createProjectEntry(id, input) {
    if (id !== projectId) return null;
    if (input.supersedes_id && !entries.some(entry => entry.id === input.supersedes_id && entry.is_current)) return { error: "conflict" };
    if (input.supersedes_id) entries.find(entry => entry.id === input.supersedes_id).is_current = false;
    const created = { id: randomUUID(), project_id: id, ...input, created_at: now, supersedes_id: input.supersedes_id, is_current: true };
    entries.unshift(created); return created;
  },
};
const server = createServer({ database, log() {} });
server.listen(8090, "127.0.0.1", () => process.stdout.write("UI fixture listening on 8090\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
