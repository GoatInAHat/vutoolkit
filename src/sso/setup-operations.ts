import { z } from "zod";
import { operation } from "../toolfactory/types.js";
import { configureIdentity, enrollSetup, prepareSetup, setupStatus } from "./setup.js";

export const setupOperations = [
  operation({
    name: "setup.identity",
    description: "Configure the account's non-secret Vanderbilt email and/or VUnetID in the native host vault. A VUnetID alone supplies its Vanderbilt sign-in address. Never accepts passwords or passkeys. Refuses to change an identity while an existing passkey is bound to another account.",
    input: z.object({ email: z.email().optional(), vunetId: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional() }),
    output: z.object({ identityConfigured: z.boolean(), emailConfigured: z.boolean(), vunetIdConfigured: z.boolean(), emailDerivedFromVunetId: z.boolean() }),
    requires: ["secret", "shell"],
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args) => configureIdentity(args),
  }),
  operation({
    name: "setup.status",
    description: "Check Vanderbilt account setup without returning credentials: configured identity, passkey validity, managed-browser availability and the next step. Existing passkeys are never replaced.",
    input: z.object({}),
    output: z.object({ identityConfigured: z.boolean(), emailConfigured: z.boolean(), passkeyConfigured: z.boolean(), passkeyValid: z.boolean(), browserAvailable: z.boolean(), readyForAuth: z.boolean(), authenticated: z.literal(false), settingsUrl: z.string(), nextStep: z.string() }),
    requires: ["secret", "net"],
    annotations: { readOnlyHint: true },
    handler: async () => setupStatus(),
  }),
  operation({
    name: "setup.prepare",
    description: "Prepare real OneVU self-service setup in a dedicated managed-browser tab. Inspect the security-method page and use an existing vaulted passkey for sign-in when available. Does not issue, replace or revoke any passkey. First-time users complete sign-in in the managed browser, never in chat.",
    input: z.object({ keepTab: z.boolean().default(true).describe("Keep the setup tab open for the user's first sign-in; false is for read-only diagnostics.") }),
    output: z.object({ status: z.enum(["ready", "sign-in-required"]), settingsUrl: z.string(), browserTabId: z.string().optional(), existingPasskeyPreserved: z.boolean(), enrollmentAvailable: z.boolean(), nextStep: z.string() }),
    requires: ["secret", "net"],
    handler: async (args) => prepareSetup(args),
  }),
  operation({
    name: "setup.enroll",
    description: "Explicitly issue a toolkit passkey through OneVU's actual security-method enrollment and store it directly in the host vault. Requires an authenticated managed browser and confirm=true. Refuses to replace an existing toolkit passkey; never revokes account credentials. This changes account security; run only after the account owner's explicit request. Returns metadata, never key material.",
    input: z.object({ confirm: z.literal(true), timeoutSeconds: z.number().int().min(15).max(300).default(120) }),
    output: z.object({ status: z.enum(["enrolled", "stored-awaiting-confirmation"]), secretName: z.string(), serverConfirmed: z.boolean(), existingPasskeysRevoked: z.boolean() }),
    requires: ["secret", "net", "shell"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args) => enrollSetup(args),
  }),
];
