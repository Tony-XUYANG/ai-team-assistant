const { test, expect } = require("@playwright/test");
const { randomUUID } = require("node:crypto");

test("real workbench persists a completed action and preserves its history", async ({ page, request, baseURL }) => {
  const target = new URL(baseURL);
  expect(target.protocol).toBe("http:");
  expect(target.hostname).toBe("127.0.0.1");
  expect(Number(target.port)).toBeGreaterThanOrEqual(8082);
  expect(Number(target.port)).toBeLessThanOrEqual(8099);
  expect(target.username + target.password + target.search + target.hash).toBe("");
  expect(target.pathname).toBe("/");

  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const name = `Workbench acceptance ${randomUUID().slice(0, 8)}`;
  const content = "Verify a completed task survives a page reload";
  await page.goto("/");
  await page.getByRole("button", { name: "\u65b0\u5efa\u9879\u76ee", exact: true }).first().click();
  await page.getByLabel("\u9879\u76ee\u540d\u79f0", { exact: true }).fill(name);
  await page.getByLabel("\u9879\u76ee\u76ee\u6807").fill("Synthetic workbench acceptance, no confidential data");
  await page.getByLabel("\u6765\u6e90\u540d\u79f0").fill("Automated browser acceptance");
  const createdResponse = page.waitForResponse(r => r.url() === `${target.origin}/projects` && r.request().method() === "POST");
  await page.getByRole("button", { name: "\u4fdd\u5b58", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const project = await created.json();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "\u6dfb\u52a0\u8bb0\u5f55", exact: true }).click();
  await page.getByLabel("\u8bb0\u5f55\u7c7b\u578b").selectOption("action");
  await page.getByLabel("\u8bb0\u5f55\u5185\u5bb9").fill(content);
  await page.getByLabel("\u786e\u8ba4\u72b6\u6001").selectOption("confirmed");
  await page.getByLabel("\u6765\u6e90\u540d\u79f0").fill("Acceptance task definition");
  await page.getByRole("button", { name: "\u4fdd\u5b58", exact: true }).click();
  const actions = page.locator('[data-section="next_actions"]');
  await expect(actions.getByText(content, { exact: true })).toBeVisible();
  await actions.getByRole("button", { name: "\u5b8c\u6210", exact: true }).click();
  await expect(page.getByLabel("\u786e\u8ba4\u72b6\u6001")).toHaveValue("unverified");
  await page.getByLabel("\u786e\u8ba4\u72b6\u6001").selectOption("confirmed");
  await page.getByLabel("\u6765\u6e90\u540d\u79f0").fill("Browser acceptance completion evidence");
  await page.getByRole("button", { name: "\u4fdd\u5b58", exact: true }).click();
  await expect(page.locator('[data-section="closed"]').getByText(content, { exact: true })).toBeVisible();
  await expect(actions.getByText(content, { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.locator('[data-section="closed"]').getByText(content, { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "\u8bb0\u5f55\u5386\u53f2", exact: true }).click();
  await expect(page.locator("#history-list .entry")).toHaveCount(2);
  await expect(page.getByText("\u5df2\u88ab\u66f4\u6b63", { exact: true })).toBeVisible();

  const historyResponse = await request.get(`/projects/${project.id}/entries`);
  expect(historyResponse.ok()).toBe(true);
  const { entries } = await historyResponse.json();
  expect(entries).toHaveLength(2);
  const current = entries.find(entry => entry.is_current);
  const previous = entries.find(entry => !entry.is_current);
  expect(current.status).toBe("done");
  expect(previous.status).toBe("todo");
  expect(current.supersedes_id).toBe(previous.id);
  expect(current.content).toBe(previous.content);
  expect(errors).toEqual([]);
  await page.screenshot({ path: ".ui-artifacts/workbench-live-history.png", fullPage: true });
});
