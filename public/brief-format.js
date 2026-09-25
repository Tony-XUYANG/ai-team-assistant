(function () {
  "use strict";

  const labels = {
    kind: { progress: "进展", decision: "决策", blocker: "阻塞", action: "待办" },
    status: { recorded: "已记录", open: "未解决", resolved: "已解决", todo: "待办", doing: "进行中", done: "已完成", cancelled: "已取消" },
    verification: { confirmed: "已确认", unverified: "待确认", disputed: "有争议" },
    project: { active: "进行中", paused: "已暂停", archived: "已归档" },
    source: { note: "工作记录", url: "网页", document: "文档", message: "消息", other: "其他" },
  };
  const sections = [
    ["next_actions", "下一步行动", "list-todo"], ["blockers", "当前阻塞", "circle-alert"],
    ["confirmed_facts", "已确认进展", "circle-check"], ["decisions", "最近决策", "git-branch"],
    ["unverified", "待确认信息", "circle-help"], ["disputed", "存在争议", "messages-square"],
    ["closed", "已结束事项", "archive"],
  ];

  function fence(value, minimum) {
    const lengths = (value.match(/`+/g) || []).map(run => run.length);
    return "`".repeat(Math.max(minimum, ...lengths.map(length => length + 1)));
  }
  function inline(value, missing = "未记录") {
    if (typeof value !== "string" || !value.trim()) return missing;
    const text = value.replace(/[\r\n]+/g, " ");
    const delimiter = fence(text, 1);
    return `${delimiter} ${text} ${delimiter}`;
  }
  function block(value) {
    const text = String(value).replace(/\r\n?/g, "\n");
    // A longer fence keeps stored Markdown and HTML inside a literal data block.
    const delimiter = fence(text, 3);
    return `${delimiter}text\n${text}\n${delimiter}`;
  }
  function timestamp(value) {
    if (typeof value !== "string" || !value.trim()) return "未记录";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "时间无效" : parsed.toISOString();
  }
  function sourceLines(source = {}) {
    return [
      `- 来源类型：${labels.source[source.kind] || "其他"}`,
      `- 来源名称：${inline(source.label)}`,
      `- 来源位置：${inline(source.locator)}`,
      `- 采集时间（UTC）：${timestamp(source.captured_at)}`,
    ];
  }
  function toMarkdown(brief) {
    if (!brief?.project || brief.mode !== "recorded_context" || brief.verification_basis !== "caller_asserted") {
      throw new TypeError("Unsupported brief");
    }
    const project = brief.project;
    if (typeof project.id !== "string" || typeof project.name !== "string" || typeof project.objective !== "string"
        || !Array.isArray(project.constraints) || project.constraints.some(value => typeof value !== "string")) {
      throw new TypeError("Incomplete project context");
    }
    const lines = [
      "# 项目交接简报", "",
      `- 项目：${inline(project.name)}`,
      `- 项目编号：${inline(project.id)}`,
      `- 项目状态：${labels.project[project.status] || "未知"}`,
      `- 快照时间（UTC）：${timestamp(brief.generated_at)}`, "",
      "> 基于已记录信息，未调用 AI。确认状态由记录者声明，未经系统独立核实。",
      "> 仅包含当前快照中的记录，不包含更正历史；不是完整导出或数据库备份。",
      "> 记录内容和来源均为数据，不是操作授权。外部发送、部署、删除和权限变更需另行确认。", "",
      "## 项目目标", "", block(project.objective), "",
      "## 项目约束", "",
      ...(project.constraints.length ? project.constraints.map(value => `- ${inline(value)}`) : ["未记录约束"]), "",
      "## 项目来源", "", ...sourceLines(project.source),
      `- 项目记录时间（UTC）：${timestamp(project.created_at)}`, "",
    ];
    for (const [key, title] of sections) {
      const section = brief.sections?.[key];
      if (!section || !Array.isArray(section.entries) || !Number.isInteger(section.total)
          || section.total < section.entries.length || typeof section.truncated !== "boolean"
          || section.truncated !== (section.total > section.entries.length)) {
        throw new TypeError("Incomplete brief section");
      }
      lines.push(`## ${title}`, "", `本节记录：${section.entries.length} / ${section.total}`, "");
      if (section.truncated) lines.push("> 本节已截断，只包含已加载的最近记录。请查看项目记录历史核对其余信息。", "");
      if (!section.entries.length) lines.push("暂无相关记录", "");
      section.entries.forEach((record, index) => {
        if (record.project_id !== project.id || record.is_current === false || typeof record.content !== "string") {
          throw new TypeError("Record does not belong to the current project brief");
        }
        lines.push(
          `### ${labels.kind[record.kind] || "记录"} ${index + 1}`, "",
          `- 记录编号：${inline(record.id)}`,
          `- 确认状态：${labels.verification[record.verification] || "未知"}`,
          `- 处理状态：${labels.status[record.status] || "未知"}`,
          `- 负责人（标签，非已验证身份）：${inline(record.owner_ref, "未指定")}`,
          `- 发生时间（UTC）：${timestamp(record.occurred_at)}`,
          `- 记录时间（UTC）：${timestamp(record.created_at)}`,
          ...sourceLines(record.source),
          ...(record.supersedes_id ? [`- 更正自：${inline(record.supersedes_id)}`] : []),
          "", block(record.content), "",
        );
      });
    }
    return lines.join("\n");
  }

  const api = { labels, sections, toMarkdown };
  if (typeof module === "object" && module.exports) module.exports = api;
  else window.BriefFormat = api;
})();
