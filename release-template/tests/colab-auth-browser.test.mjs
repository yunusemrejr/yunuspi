import test from "node:test";
import assert from "node:assert/strict";

const helper = await import(new URL("../agent/scripts/colab-auth-browser.mjs", import.meta.url).href);

test("extractAuthCode reads the code Google displays and ignores URLs and client ids", () => {
  assert.equal(helper.extractAuthCode("Authorization code:\n4/0AX4XfWh1234567890abcdefghijKLMNOP"), "4/0AX4XfWh1234567890abcdefghijKLMNOP");
  assert.equal(helper.extractAuthCode("1//0gAbCdEfGhIjKlMnOpQrStUvWxYz012345"), "1//0gAbCdEfGhIjKlMnOpQrStUvWxYz012345");
  assert.equal(helper.extractAuthCode("code: AbCdEfGhIjKlMnOpQrStUvWxYz0123"), "AbCdEfGhIjKlMnOpQrStUvWxYz0123");
  assert.equal(helper.extractAuthCode("https://accounts.google.com/o/oauth2/auth?client_id=764086051850-abc"), null);
  assert.equal(helper.extractAuthCode(""), null);
  assert.equal(helper.extractAuthCode("No code here"), null);
});

test("authStage names the OAuth step without exposing query state", () => {
  assert.equal(helper.authStage("https://accounts.google.com/v3/signin/identifier?opparams=x"), "sign-in");
  assert.equal(helper.authStage("https://accounts.google.com/o/oauth2/auth?client_id=x"), "accounts");
  assert.equal(helper.authStage("https://accounts.google.com/oauth/consent?authuser=0"), "consent");
  assert.equal(helper.authStage("https://sdk.cloud.google.com/applicationdefaultauthcode.html"), "code-page");
  assert.equal(helper.authStage("not a url"), "unknown");
});

test("chooseAction waits for a human on password, 2-step and sign-in pages", () => {
  assert.equal(helper.chooseAction({ href: "https://accounts.google.com/", text: "", inputs: [{ type: "password", value: "" }], accounts: [], buttons: [], codeContainers: [] }).kind, "needs_user");
  assert.equal(helper.chooseAction({ href: "https://accounts.google.com/", text: "2-step verification", inputs: [], accounts: [], buttons: [], codeContainers: [] }).kind, "needs_user");
  assert.equal(helper.chooseAction({ href: "https://accounts.google.com/v3/signin/identifier", text: "Sign in", inputs: [{ type: "text", name: "identifier", value: "" }], accounts: [], buttons: [{ index: 1, text: "Next", disabled: false }], codeContainers: [] }).kind, "needs_user");
  assert.equal(helper.chooseAction({ href: "https://accounts.google.com/", text: "not a robot", inputs: [], accounts: [], buttons: [{ index: 1, text: "Next", disabled: false }], codeContainers: [] }).kind, "needs_user");
});

test("chooseAction picks an existing account then a consent button, and never Cancel", () => {
  const account = helper.chooseAction({ href: "https://accounts.google.com/AccountChooser", text: "", inputs: [], accounts: [{ identifier: "a@example.com", text: "A" }, { identifier: "b@example.com", text: "B" }], buttons: [], codeContainers: [] });
  assert.equal(account.kind, "click_account");
  assert.equal(account.identifier, "a@example.com");
  const preferred = helper.chooseAction({ href: "https://accounts.google.com/AccountChooser", text: "", inputs: [], accounts: [{ identifier: "a@example.com", text: "A" }, { identifier: "b@example.com", text: "B" }], buttons: [], codeContainers: [] }, "b@example.com");
  assert.equal(preferred.identifier, "b@example.com");
  const consent = helper.chooseAction({ href: "https://accounts.google.com/oauth/consent", text: "Google Auth Library wants access", inputs: [], accounts: [], buttons: [{ index: 2, text: "Cancel", disabled: false }, { index: 3, text: "Continue", disabled: false }], codeContainers: [] });
  assert.equal(consent.kind, "click_button");
  assert.equal(consent.text, "Continue");
});

test("playwrightCookies keeps only fields Chromium accepts", () => {
  const cookies = helper.playwrightCookies([
    { name: "SID", value: "v", domain: ".google.com", path: "/", secure: true, httpOnly: true, sameSite: "None", expires: 123 },
    { name: "bad", value: "v" },
    { name: 1, value: "v", domain: ".google.com" },
    null,
  ]);
  assert.equal(cookies.length, 1);
  assert.deepEqual(cookies[0], { name: "SID", value: "v", domain: ".google.com", path: "/", httpOnly: true, secure: true, expires: 123, sameSite: "None" });
  assert.deepEqual(helper.playwrightCookies("not an array"), []);
});
