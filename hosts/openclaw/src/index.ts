// Authored OpenClaw adapter; adopted from Tool Factory to forward caller signals.
import { join } from "node:path";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { Type } from "typebox";
import { operations } from "vutoolkit/dist/ops.js";
import { web } from "vutoolkit/dist/toolfactory/web.js";
import { handler } from "vutoolkit/dist/toolfactory/mcp.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Where this tool may keep its own state: OpenClaw's state directory, one folder per plugin.
 * Lazy, so that importing this module resolves no path and touches no disk — every host loader
 * and `plugin-inspector check --runtime` import the entry long before any tool runs.
 */
const dataDir = () => join(resolveStateDir(), "plugin-data", "vutoolkit");

const entry = defineToolPlugin({
  id: "vutoolkit",
  name: "Vutoolkit",
  description: "Universal toolkit for Vanderbilt student life - OneVU SSO and passkey sessions, what-if grades, YES tools; built for AI agents first.",
  activation: {
    "onStartup": true
  },
  configSchema: Type.Unsafe<Record<string, unknown>>({
    "type": "object",
    "properties": {
      "VUTOOLKIT_CREDENTIAL_STORE": {
        "type": "string",
        "enum": [
          "file",
          "openclaw"
        ],
        "default": "file",
        "description": "Credential cache backend. Select openclaw on OpenClaw hosts to store sessions and Graph tokens in the native vault; file preserves standalone 0600 storage."
      }
    },
    "additionalProperties": false
  }),
  // Authored native adapter: derive schemas from the core and forward caller cancellation.
  tools: (tool) => [...operations, web].sort((a, b) => a.name.localeCompare(b.name)).map(op => tool({
    name: "vutoolkit_" + op.name.replaceAll(".", "_"),
    description: op.description,
    parameters: Type.Unsafe(op.input.toJSONSchema()),
    execute: async (params, config, execution) => op.handler(op.input.parse(params) as never, {
      config: config as Record<string, string | undefined>,
      dataDir: dataDir(),
      ...{ signal: execution.signal },
    }),
  })),
});

/**
 * The web app, as a tab in the Control UI: one prefix route the gateway authenticates, handled
 * by the core package's own exported router — so `<prefix>/mcp` is answered in-process by the
 * same operations and everything else is the built page — and one descriptor that makes the
 * dashboard render it, instead of a URL an operator has to go and find.
 */
const WEB_PATH = "/plugins/vutoolkit/web";

const registerTools = entry.register;
entry.register = (api: OpenClawPluginApi) => {
  registerTools(api);
  api.registerHttpRoute({
    path: WEB_PATH,
    match: "prefix",
    // A Control UI tab may only point at a gateway-authenticated route, and the operator's
    // gateway session is the authentication — the page needs no pairing token of its own.
    auth: "gateway",
    // `env: false`: the Secrets panel writes the developer's `.env` in their checkout, and
    // this plugin runs in the gateway's working directory, not theirs.
    handler: handler({ path: `${WEB_PATH}/mcp`, prefix: WEB_PATH, env: false }),
  });
  const descriptor = {
    id: "vutoolkit-web",
    surface: "tab" as const,
    label: "Vutoolkit",
    path: `${WEB_PATH}/`,
  };
  // `api.session.controls` is the current facade and the top-level registrar its deprecated
  // alias; the plugin inspector's mock SDK has only the latter, so take whichever is there.
  const controls = api.session?.controls;
  if (controls) controls.registerControlUiDescriptor(descriptor);
  else api.registerControlUiDescriptor(descriptor);
};


export default entry;
