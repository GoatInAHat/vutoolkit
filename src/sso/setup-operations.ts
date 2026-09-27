import { z } from "zod";
import { operation } from "../toolfactory/types.js";
import { configureIdentity, enrollSetup, prepareSetup, setupStatus } from "./setup.js";
import { runSetup } from "./setup-run.js";

export const setupOperations = [
  operation({
    name: "setup.run",
    description: "Deterministic one-call Vanderbilt setup or explicit passkey recovery. Uses this host's configured identity and optional vaulted VANDERBILT_PASSWORD, first reusing an authenticated browser session. On first-time setup it enrolls and vault-verifies a new OneVU passkey, then establishes Vanderbilt and Microsoft sessions. status=partial means Vanderbilt is ready but Microsoft is not; do not claim full setup. Existing valid keys are reused, never rotated. recovery=true skips a rejected key and preserves it as a vault backup. With allowInteractiveVerification=false, setup does not submit a password or click a verification factor; OneVU may still require step-up for enrollment. Returns no credentials. Typed errors tell the caller what prerequisite or one-time verification is missing.",
    input: z.object({
      confirm: z.literal(true).describe("Account-holder authorization to enroll a toolkit passkey if necessary."),
      recovery: z.boolean().default(false).describe("Only when the existing toolkit key was rejected by OneVU; preserve it and enroll a replacement."),
      allowInteractiveVerification: z.boolean().default(true).describe("False: use an existing signed-in browser session only; never submit a password or click a verification factor. OneVU may independently require step-up."),
      timeoutSeconds: z.number().int().min(15).max(300).default(180),
    }),
    output: z.object({
      status: z.enum(["ready", "partial"]),
      passkey: z.enum(["existing", "enrolled", "recovered"]),
      passkeyAssertion: z.literal("verified").describe("The active vaulted key completed an isolated OneVU WebAuthn assertion; its observed counter was saved."),
      vanderbiltSession: z.literal("ready"),
      microsoftSession: z.enum(["ready", "not-ready"]),
      microsoftError: z.string().optional().describe("Safe failure code when Microsoft session is not ready; no account data or token values."),
      microsoftNextStep: z.string().optional(),
      verificationRequired: z.literal(false),
    }),
    requires: ["secret", "net", "shell"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => runSetup(ctx.dataDir, args),
  }),
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
    description: "Check Vanderbilt account setup without returning credentials: configured identity, structural passkey validity, managed-browser availability and the next step. Structural validity does not prove OneVU accepts the key.",
    input: z.object({}),
    output: z.object({ identityConfigured: z.boolean(), emailConfigured: z.boolean(), passkeyConfigured: z.boolean(), passkeyValid: z.boolean(), browserAvailable: z.boolean(), readyForAuth: z.boolean(), authenticated: z.literal(false), settingsUrl: z.string(), nextStep: z.string() }),
    requires: ["secret", "net"],
    annotations: { readOnlyHint: true },
    handler: async () => setupStatus(),
  }),
  operation({
    name: "setup.prepare",
    description: "Prepare a dedicated OneVU tab for the account holder to sign in. Normal setup may load the configured toolkit passkey; recovery=true deliberately does not load or retry the rejected key and requires the holder to use their usual sign-in method. Does not issue or change credentials. The visible page must match the configured student's email before enrollment.",
    input: z.object({ keepTab: z.boolean().default(true).describe("Keep the dedicated OneVU tab open so the account holder can sign in."), recovery: z.boolean().default(false).describe("Recovery only: do not load/use the rejected toolkit passkey; allow the account holder to sign in through OneVU's normal flow.") }),
    output: z.object({ status: z.enum(["ready", "sign-in-required"]), settingsUrl: z.string(), browserTabId: z.string().optional(), existingPasskeyPreserved: z.boolean(), recoveryMode: z.boolean(), identityMatched: z.boolean(), enrollmentAvailable: z.boolean(), nextStep: z.string() }),
    requires: ["secret", "net"],
    handler: async (args) => prepareSetup(args),
  }),
  operation({
    name: "setup.enroll",
    description: "Issue a toolkit passkey through OneVU's security-method enrollment. Requires authenticated managed-browser sign-in and explicit account-holder confirmation. For recovery only, replaceExisting=true stages and vault-verifies the newly issued credential, preserves the prior key in VANDERBILT_PASSKEY_PREVIOUS, then promotes the new key; use only after the account holder reports the current toolkit key was rejected and confirms the browser is signed into their own configured account. Never accepts secrets in arguments or revokes OneVU passkeys. Returns metadata only.",
    input: z.object({ confirm: z.literal(true), replaceExisting: z.boolean().default(false).describe("Recovery only: replace the toolkit's current vaulted key after OneVU issues and the host vault verifies a new one. Requires explicit account-holder confirmation."), timeoutSeconds: z.number().int().min(15).max(300).default(120) }),
    output: z.object({ status: z.enum(["enrolled", "stored-awaiting-confirmation"]), secretName: z.string(), serverConfirmed: z.boolean(), existingPasskeysRevoked: z.boolean() }),
    requires: ["secret", "net", "shell"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args) => enrollSetup(args),
  }),
];
