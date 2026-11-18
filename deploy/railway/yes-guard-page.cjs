// Playwright MCP `browser.initPage` hook: every page of the signed-in browser runs vutoolkit's YES
// guard, so the browser can read YES but cannot change enrollment, the cart or the planner.
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

const guarded = new WeakSet();

exports.default = async ({ page }) => {
  const context = page.context();
  if (guarded.has(context)) return;
  guarded.add(context);
  const { isYesHost, classify } = await import(pathToFileURL(join(__dirname, "../../dist/yes/guard.js")).href);
  await context.route(
    (url) => isYesHost(url.hostname),
    (route) => {
      const request = route.request();
      return classify(request.url(), request.method()) === "read" ? route.fallback() : route.abort("blockedbyclient");
    },
  );
};
