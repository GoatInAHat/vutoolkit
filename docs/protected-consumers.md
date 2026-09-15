# Protected passkey consumer: source-only checkpoint

## Supported native boundary

Inspected the installed OpenClaw docs and SDK source on 2026-09-13; no credential values were read.

| Evidence | Supported behavior |
| --- | --- |
| [Manifest config and secrets](https://docs.openclaw.ai/plugins/manifest/config-and-secrets#secretinputs-paths) | `configContracts.secretInputs.paths` declares plugin-config leaves for startup resolution and redaction. Plugins receive resolved values. `ownerKind: "capability"` fails cold when unavailable. |
| [Secrets runtime model](https://docs.openclaw.ai/gateway/secrets/runtime-model) | Runtime consumers use the active in-memory snapshot; no per-request CLI/provider resolution. |
| [SDK subpaths](https://docs.openclaw.ai/plugins/sdk-subpaths) | `openclaw/plugin-sdk/secret-input-runtime` exports capability availability guards and configured SecretRef resolution helpers. `secret-ref-readonly` is env-specific, not a protected-store reveal API. |
| [Store and egress](https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress) | Protected entries are not plaintext subprocess env. Egress substitution handles HTTPS requests, not local signing or CDP WebSocket message frames. |
| [Credential surface](https://docs.openclaw.ai/reference/secretref-credential-surface) | Read-only SecretRef resolution does not cover runtime-minted/rotating session artifacts. |

Installed evidence root: `/home/openclaw/.openclaw/tools/node-v24.19.0/lib/node_modules/openclaw`.
Reviewed `dist/plugin-sdk/secret-input-runtime.{js,d.ts}`, `secret-ref-readonly.d.ts`,
the exported configured-resolution implementation, and the `OpenClawPluginApi` declaration
(`pluginConfig`, native runtime helpers). No private store/SQLite helper is imported by VU.

## Implemented offline

`src/vault/resolved-passkey.ts` implements the existing `SecretLoader` interface for **one
host-bound reference**. Its callback consumes an already-resolved native config leaf; it is
not a new secret resolver. Missing values, unresolved ref objects, sentinel strings, malformed
keys, unsupported formats, and host availability failures fail closed with fixed errors.
No CLI/env/file fallback, value logging, session writes, or counter mutation exists here.

Normalization supports the versioned P-256 JWK envelope and non-resident CDP/PKCS#8 JSON.
Legacy `userHandle` encoding must be explicitly supplied (`utf8` or `base64`), because those
formats are ambiguous. The recovered script excerpt encodes its string handle as UTF-8 before
base64, but the synthetic proof does not validate any live stored value. Resident credentials
remain unsupported rather than silently downgraded. The counter must fit unsigned 32-bit.

Synthetic proof wires resolved JSON → loader → CDP stub and compares the original private-key
DER, credential ID, RP binding, handle bytes, and counter. It also exercises degradation after
a successful read. This proves local conversion/consumer behavior, **not native activation,
WebAuthn server acceptance, durable counters, session health, or successful login**.

## Unwired runtime activation

The generated plugin entry/manifest and live configuration were intentionally left untouched.
The consumer is not registered with operations. Native activation would require a declared
config leaf (for example `passkeyMaterial`, `expected: "string"`, `ownerKind: "capability"`),
a schema requiring a structured protected-store SecretRef in source configuration, and a
trusted plugin callback guarded by `assertPluginCapabilitySecretAvailable` for that exact
config path. Its snapshot must be refreshed through native reload lifecycle handling, not
retained as a stale plaintext closure. The existing string argument on `SecretLoader` is only
an internal binding identifier; it does not authorize arbitrary store lookups.

Secret-kind classification/migration belongs to its coordinating owner. This source does not
check or change store classification. Actual registration must use toolfactory-owned source
generation/adoption, not hand-edit its generated projections.

## Exact bounded dependencies before live enablement

1. **Protected session store:** a supported trusted-native API to write/read/delete an
   origin-scoped session bundle, expose metadata separately, and inject cookies only into an
   authorized local browser/request target without returning values through tools or writing
   cookie files. Current `SessionStore` is just an interface. Generic plugin keyed state is
   not evidence of a protected credential store; the installed SDK labels plugin-state helpers
   private-local. No suitable public protected-session contract was identified in this audit.
2. **Atomic per-credential counter state:** a supported durable transaction/CAS or exclusive
   ceremony lease keyed by credential, authoritative over the startup credential snapshot.
   It must serialize concurrent sessions, reserve/advance counts without wraparound, reconcile
   CDP assertion events, and retain the high-water mark even when server/network outcome is
   unknown. Re-reading the original credential's counter or only saving on confirmed login
   cannot supply that guarantee. No such public credential-counter contract was identified.
3. **Trusted execution boundary:** actual native lifecycle binding of the supported config
   path to this loader and a local signer/CDP owner. HTTPS egress must never receive the private
   key. A separate broker is needed if the execution owner is out of process; no general
   protected-secret reveal endpoint is assumed or added.
4. **Verified login flow and authenticated health check:** still unresolved, independent of
   storage. Existing OneVU evidence does not rule out other passwordless paths.

`sessions.open` and `sessions.refresh` remain gated. No claim is made that the existing ceremony
scaffold proves authentication merely by returning cookies.

## Offline verification

Run from the repository root (installed dependencies only):

```sh
node_modules/.bin/vitest run src/vault/resolved-passkey.test.ts src/sso/virtual-authenticator.test.ts src/sso/assertion.test.ts --maxWorkers=1
node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node src/vault/resolved-passkey.ts src/vault/resolved-passkey.test.ts src/sso/virtual-authenticator.test.ts
```

The tests use fresh generated keys and stub CDP; they start no browser and make no network calls.
