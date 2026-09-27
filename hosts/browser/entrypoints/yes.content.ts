import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { mountYesScheduler } from "../utils/yes-ui";
export default defineContentScript({
  matches: ["https://*.vanderbilt.edu/more/SearchClasses*"],
  main() {
    mountYesScheduler({
      loadPreferences: async () => (await browser.storage.local.get("yesSchedulerPreferences")).yesSchedulerPreferences ?? {},
      savePreferences: async (preferences) => { await browser.storage.local.set({ yesSchedulerPreferences: preferences }) },
      professorSearch: async (name) => {
        const reply = await browser.runtime.sendMessage({ type: "mcp", request: { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "professors.search", arguments: { name } } } });
        if (reply.error) throw new Error(reply.error);
        return reply.value;
      },
    });
  },
});
