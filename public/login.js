"use strict";
const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");
let mode = "login";
window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
for (const tab of document.querySelectorAll("[data-mode]")) {
  tab.addEventListener("click", () => {
    mode = tab.dataset.mode;
    for (const item of document.querySelectorAll("[data-mode]")) item.setAttribute("aria-selected", String(item === tab));
    document.querySelector("#activation-field").hidden = mode !== "activate";
    form.elements.activation_code.required = mode === "activate";
    form.elements.password.autocomplete = mode === "activate" ? "new-password" : "current-password";
    document.querySelector(".login-submit").textContent = mode === "activate" ? "激活并登录" : "登录";
    error.hidden = true;
  });
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = form.querySelector("[type=submit]");
  button.disabled = true; error.hidden = true;
  const body = { username: form.elements.username.value, password: form.elements.password.value };
  if (mode === "activate") body.activation_code = form.elements.activation_code.value.trim();
  try {
    const response = await fetch("/api/v1/auth/" + mode, { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      error.textContent = response.status === 429 ? "尝试过于频繁，请稍后重试。" : response.status === 401
        ? "账号信息或激活码不正确。" : "操作失败，请检查输入后重试。";
      error.hidden = false; return;
    }
    location.replace("/");
  } catch { error.textContent = "连接失败，请检查本地服务。"; error.hidden = false; }
  finally { button.disabled = false; }
});
