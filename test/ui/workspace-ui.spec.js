const { test, expect } = require("@playwright/test");
const id = "12345678-1234-4123-8123-123456789abc";

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /Content Security Policy|lucide/i.test(message.text())) errors.push(message.text()); });
  page.on("close", () => expect(errors).toEqual([]));
});

test("desktop workbench shows current project context and records a completed action", async ({ page }) => {
  await page.goto("/#project=12345678-1234-4123-8123-123456789abc");
  await expect(page.getByRole("heading", { name: "网站发布" })).toBeVisible();
  await expect(page.getByText("检查首页移动端表现")).toBeVisible();
  await expect(page.getByText("已确认待办", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".ui-artifacts/workbench-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "完成" }).click();
  await expect(page.getByRole("heading", { name: "完成待办" })).toBeVisible();
  await page.getByLabel("来源名称").fill("移动端验收记录");
  await page.getByRole("button", { name: /保存/ }).click();
  await expect(page.getByText("记录已保存")).toBeVisible();
  await expect(page.getByText(/移动端验收记录/).first()).toBeVisible();
  await page.getByRole("tab", { name: "记录历史" }).click();
  await expect(page.getByText("已被更正")).toBeVisible();
});

test("mobile workbench opens project navigation and keeps primary action visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#project=12345678-1234-4123-8123-123456789abc");
  await expect(page.getByRole("heading", { name: "网站发布" })).toBeVisible();
  await page.getByRole("button", { name: "打开项目导航" }).click();
  await expect(page.locator("#sidebar")).toHaveClass(/open/);
  await page.getByRole("button", { name: "关闭项目导航" }).click();
  await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
  await expect(page.getByRole("button", { name: /添加记录/ })).toBeVisible();
  await expect.poll(() => page.locator("#sidebar").evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".ui-artifacts/workbench-mobile.png", fullPage: true, animations: "disabled" });
});

test("empty state opens project form and missing data remains a visible error", async ({ page }) => {
  await page.route("**/projects?*", route => route.fulfill({ json: { projects: [], next_offset: null } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "从一个项目开始" })).toBeVisible();
  await page.locator("#welcome-create").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("项目名称").fill("未保存项目");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("项目名称")).toHaveValue("未保存项目");
});

test("API failures keep draft and request ID without automatic resubmission", async ({ page }) => {
  await page.goto(`/#project=${id}`);
  await page.getByRole("button", { name: "添加记录", exact: true }).click();
  await page.getByLabel("记录内容").fill("需要保留的草稿\n第二行");
  await page.getByLabel("来源名称").fill("测试证据");
  let requests = 0;
  await page.route(`**/projects/${id}/entries`, route => {
    requests++;
    return route.fulfill({ status: 503, headers: { "x-request-id": "test-failure-123" }, json: { error: "Database unavailable" } });
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("test-failure-123");
  await expect(page.getByLabel("记录内容")).toHaveValue("需要保留的草稿\n第二行");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  expect(requests).toBe(1);
});

test("revision conflicts preserve draft and require fresh history", async ({ page }) => {
  await page.goto(`/#project=${id}`);
  await page.getByRole("button", { name: "更正记录", exact: true }).first().click();
  await page.getByLabel("来源名称").fill("发生冲突的更正");
  await page.route(`**/projects/${id}/entries`, route => route.fulfill({ status: 409, json: { error: "conflict" } }));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已被更新");
  await expect(page.getByLabel("来源名称")).toHaveValue("发生冲突的更正");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
});

test("brief failure is visible and retry restores the project", async ({ page }) => {
  let fail = true;
  await page.route(`**/projects/${id}/brief`, route => fail ? route.fulfill({ status: 503, json: { error: "unavailable" } }) : route.continue());
  await page.goto(`/#project=${id}`);
  await expect(page.locator("#page-error")).toContainText("数据库暂时不可用");
  await expect(page.locator("#project-view")).toBeHidden();
  fail = false;
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByRole("heading", { name: "网站发布" })).toBeVisible();
});

test("stored markup is plain text and unsafe source links never become anchors", async ({ page, request }) => {
  const brief = await (await request.get(`/projects/${id}/brief`)).json();
  const record = { id: "32345678-1234-4123-8123-123456789abc", kind: "progress", content: '<img src=x onerror="window.injected=true">',
    verification: "unverified", status: "recorded", source: { kind: "note", label: "Unsafe example", locator: "javascript:alert(1)" }, created_at: brief.generated_at };
  brief.sections.unverified = { entries: [record], total: 1, truncated: false };
  await page.route(`**/projects/${id}/brief`, route => route.fulfill({ json: brief }));
  await page.goto(`/#project=${id}`);
  await expect(page.getByText(record.content, { exact: true })).toBeVisible();
  expect(await page.locator(".entry-content img").count()).toBe(0);
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test("a slow previous project response cannot overwrite a newly selected project", async ({ page, request }) => {
  const original = await (await request.get(`/projects/${id}/brief`)).json();
  const otherId = "42345678-1234-4123-8123-123456789abc";
  const other = structuredClone(original); other.project.id = otherId; other.project.name = "另一个项目";
  await page.route("**/projects?*", route => route.fulfill({ json: { projects: [original.project, other.project], next_offset: null } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/projects/${id}/brief`, async route => { await gate; await route.fulfill({ json: original }); });
  await page.route(`**/projects/${otherId}/brief`, route => route.fulfill({ json: other }));
  await page.goto(`/#project=${id}`);
  await page.getByRole("button", { name: "另一个项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "另一个项目" })).toBeVisible();
  release();
  await expect(page.getByRole("heading", { name: "另一个项目" })).toBeVisible();
});

test("white background and module colors stay consistent across responsive layouts", async ({ page }) => {
  await page.goto(`/#project=${id}`);
  await expect(page.locator("#brief-sections h2")).toHaveCount(7);
  for (const selector of ["html", "body", "main", ".sidebar", ".security-note"]) {
    await expect(page.locator(selector)).toHaveCSS("background-color", "rgb(255, 255, 255)");
  }
  for (let index = 0; index < 2; index++) {
    await expect(page.locator(".stat").nth(index)).toHaveCSS("background-color", "rgb(255, 244, 232)");
    await expect(page.locator(".stat").nth(index)).toHaveCSS("border-left-color", "rgb(198, 92, 11)");
    await expect(page.locator(".stat-label").nth(index)).toHaveCSS("color", "rgb(154, 71, 9)");
  }
  await expect(page.locator(".stat").nth(2)).toHaveCSS("background-color", "rgb(255, 248, 232)");
  for (const width of [320, 390, 639, 820, 1280]) {
    await page.setViewportSize({ width, height: 702 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const headings = await page.locator("#brief-sections h2").evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const parent = node.parentElement.getBoundingClientRect();
      return { left: rect.left, right: rect.right, parentLeft: parent.left, parentRight: parent.right,
        accent: style.borderLeftColor, border: parseFloat(style.borderLeftWidth), background: style.backgroundColor,
        contentWidth: node.scrollWidth, boxWidth: node.clientWidth };
    }));
    expect([...new Set(headings.map(heading => heading.accent))]).toEqual(["rgb(29, 98, 198)"]);
    for (const heading of headings) {
      expect(heading.border).toBeGreaterThanOrEqual(3);
      expect(heading.background).toBe("rgb(237, 245, 255)");
      expect(heading.left).toBeGreaterThanOrEqual(heading.parentLeft);
      expect(heading.right).toBeLessThanOrEqual(heading.parentRight + 1);
      expect(heading.contentWidth).toBeLessThanOrEqual(heading.boxWidth + 1);
    }
    const title = await page.locator(".project-heading>div").boundingBox();
    const action = await page.locator("#new-entry").boundingBox();
    expect(title.x + title.width).toBeLessThanOrEqual(action.x);
    await expect(page.locator("#new-entry")).toBeVisible();
    if (width === 639) await page.screenshot({ path: ".ui-artifacts/workbench-narrow.png", fullPage: true });
  }
});
