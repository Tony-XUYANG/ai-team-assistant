const test = require("node:test");
const assert = require("node:assert/strict");
const { toMarkdown } = require("../public/brief-format.js");

const projectId = "12345678-1234-4123-8123-123456789abc";
const source = { kind: "note", label: "Acceptance note", captured_at: "2026-09-25T00:00:00.000Z" };
const sectionNames = ["next_actions", "blockers", "confirmed_facts", "decisions", "unverified", "disputed", "closed"];

function brief(overrides = {}) {
  const project = { id: projectId, name: "网站发布", objective: "发布审阅后的首页\n保留换行", constraints: ["只使用 JavaScript"],
    status: "active", source, created_at: "2026-09-25T00:00:00.000Z" };
  const sections = Object.fromEntries(sectionNames.map(key => [key, { entries: [], total: 0, truncated: false }]));
  sections.next_actions = { entries: [{ id: "entry-1", project_id: projectId, kind: "action", content: "检查 `script` 和 <img src=x>",
    verification: "confirmed", status: "todo", owner_ref: "负责人标签", occurred_at: "2026-09-25T00:00:00.000Z", created_at: "2026-09-25T00:00:00.000Z", source }], total: 1, truncated: false };
  return { mode: "recorded_context", verification_basis: "caller_asserted", generated_at: "2026-09-25T01:00:00.000Z", project, sections, ...overrides };
}

test("Markdown handoff contains explicit trust boundaries and literal record content", () => {
  const output = toMarkdown(brief());
  assert.match(output, /^# 项目交接简报/m);
  assert.match(output, /> 基于已记录信息，未调用 AI。确认状态由记录者声明，未经系统独立核实。/);
  assert.match(output, /项目目标[\s\S]*发布审阅后的首页\n保留换行/);
  assert.match(output, /检查 `script` 和 <img src=x>/);
  assert.match(output, /负责人（标签，非已验证身份）/);
  assert.match(output, /来源名称：` Acceptance note `/);
  assert.doesNotMatch(output, /undefined|null/);
});

test("Markdown handoff reports bounded sections and rejects inconsistent data", () => {
  const truncated = brief();
  truncated.sections.unverified = { entries: [{ id: "entry-2", project_id: projectId, kind: "progress", content: "pending",
    verification: "unverified", status: "recorded", source }], total: 3, truncated: true };
  const output = toMarkdown(truncated);
  assert.match(output, /本节记录：1 \/ 3/);
  assert.match(output, /本节已截断/);
  assert.throws(() => toMarkdown(brief({ verification_basis: "ai_generated" })), TypeError);
  assert.throws(() => toMarkdown(brief({ sections: { ...brief().sections, blockers: { entries: [], total: 2, truncated: false } } })), TypeError);
  const foreign = brief();
  foreign.sections.next_actions.entries[0].project_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.throws(() => toMarkdown(foreign), TypeError);
});
