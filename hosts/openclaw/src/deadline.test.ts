import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { describe, expect, it } from "vitest";
import { ceremonyTools } from "vutoolkit/dist/sso/budget.js";
import entry from "./index.js";
describe("native caller budgets", () => {
  for (const name of ceremonyTools) it(name, () => {
    const native = getToolPluginMetadata(entry)!.tools.find(t => t.name === "vutoolkit_" + name.replaceAll(".", "_"))!;
    const schema = native.parameters as { properties: Record<string, { minimum?: number; maximum?: number; type?: string }> };
    expect(schema.properties.timeoutSeconds).toMatchObject({ type: "integer", minimum: 1, maximum: 570 });
    expect(native.description).toContain("timeoutSeconds: 300");
  });
});
