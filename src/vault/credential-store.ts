import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VaultNotWiredError } from "./index.js";

export interface CredentialStorage {
  readonly location: string;
  read(): string | null;
  write(value: string): Promise<void>;
}

export interface NativeSecrets {
  read(name: string): string | null;
  write(name: string, value: string): Promise<void>;
}

/**
 * The CLI's online store write routes back through this Gateway over the local socket
 * (runWithLocalStateOwner -> secrets.store.set). A synchronous child would block the same
 * event loop that must answer it, so the write is a non-blocking child and the caller awaits.
 */
function runNativeWrite(args: string[], input: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn("openclaw", args, { stdio: ["pipe", "pipe", "ignore"] });
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish(() => reject(new Error("native credential vault write timed out")));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 131_072) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("native credential vault response exceeded the bound")));
      }
    });
    child.stdin?.on("error", () => { /* close/exit decides the outcome */ });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (code === 0) finish(() => resolve(stdout.trim()));
      else finish(() => reject(new Error("native credential vault write exited " + String(code))));
    });
    child.stdin?.end(input, "utf8");
  });
}

export const nativeSecrets: NativeSecrets = {
  read(name) {
    try {
      return execFileSync("openclaw", ["secrets", "store", "get", name, "--plain"], {
        encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 131_072,
      }).trim();
    } catch (error) {
      if ((error as { status?: number })?.status === 3) return null;
      throw new VaultNotWiredError("Native credential vault read failed; no filesystem fallback was used.");
    }
  },
  async write(name, value) {
    try {
      await runNativeWrite(["secrets", "store", "set", name, "--kind", "env", "--value-file", "-"], value);
    } catch {
      throw new VaultNotWiredError("Native credential vault write failed; no credential was written to a cache file.");
    }
  },
};

export type CredentialKind = "sessions_vanderbilt" | "sessions_microsoft" | "graph";

export function credentialSecretName(dataDir: string, kind: CredentialKind): string {
  const scope = createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 24).toUpperCase();
  return `VUTOOLKIT_${scope}_${kind.toUpperCase()}`;
}

export class NativeCredentialStorage implements CredentialStorage {
  readonly location: string;
  constructor(readonly name: string, private readonly secrets: NativeSecrets = nativeSecrets) {
    this.location = `openclaw-vault:${name}`;
  }

  read(): string | null {
    return this.secrets.read(this.name);
  }

  async write(value: string): Promise<void> {
    if (Buffer.byteLength(value, "utf8") > 65_536)
      throw new VaultNotWiredError("Credential envelope exceeds the native vault's 64 KiB limit.");
    await this.secrets.write(this.name, value);
    if (this.secrets.read(this.name) !== value)
      throw new VaultNotWiredError("Native credential vault readback did not match; preserve the original cache.");
  }
}

export function credentialStorage(
  dataDir: string,
  kind: CredentialKind,
  env: NodeJS.ProcessEnv = process.env,
  secrets: NativeSecrets = nativeSecrets,
): CredentialStorage | undefined {
  const mode = env.VUTOOLKIT_CREDENTIAL_STORE ?? "file";
  if (mode === "file") return undefined;
  if (mode !== "openclaw") throw new VaultNotWiredError("VUTOOLKIT_CREDENTIAL_STORE must be openclaw or file.");
  const storage = new NativeCredentialStorage(credentialSecretName(dataDir, kind), secrets);
  const legacy = join(dataDir, kind.startsWith("sessions_") ? "sessions.vault.json" : "graph-token.json");
  return {
    location: storage.location,
    read() {
      const value = storage.read();
      if (value === null && existsSync(legacy))
        throw new VaultNotWiredError("Legacy credential cache needs verified migration to the native vault before use.");
      return value;
    },
    async write(value) {
      if (storage.read() === null && existsSync(legacy))
        throw new VaultNotWiredError("Legacy credential cache needs verified migration before a new value can be stored.");
      await storage.write(value);
    },
  };
}

/** Call with credential writers quiesced. Originals remain until the integrator verifies cutover. */
export async function migrateCredentialCaches(dataDir: string, secrets: NativeSecrets = nativeSecrets): Promise<{ migrated: Array<{ kind: CredentialKind; secretName: string; verified: true }>; originalsPreserved: true }> {
  const migrated: Array<{ kind: CredentialKind; secretName: string; verified: true }> = [];
  for (const sourceKind of ["sessions", "graph"] as const) {
    const path = join(dataDir, sourceKind === "sessions" ? "sessions.vault.json" : "graph-token.json");
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8").trim();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw); } catch {
      throw new VaultNotWiredError("Legacy credential cache is invalid JSON; original preserved.");
    }
    const valid = parsed && typeof parsed === "object" && (sourceKind === "sessions"
      ? parsed.version === 1 && parsed.rows !== null && typeof parsed.rows === "object" && !Array.isArray(parsed.rows)
      : typeof parsed.accessToken === "string" && parsed.accessToken.length > 0 &&
        Number.isFinite(parsed.acquiredAtMs) && Number.isFinite(parsed.expiresAtMs));
    if (!valid) throw new VaultNotWiredError("Legacy credential cache has an invalid shape; original preserved.");
    const entries: Array<[CredentialKind, string]> = sourceKind === "sessions"
      ? (["vanderbilt", "microsoft"] as const).map((idp) => [
          `sessions_${idp}` as CredentialKind,
          JSON.stringify((parsed.rows as Record<string, unknown>)[idp] ?? null),
        ])
      : [["graph", raw]];
    for (const [kind, value] of entries) {
      const storage = new NativeCredentialStorage(credentialSecretName(dataDir, kind), secrets);
      const existing = storage.read();
      if (existing !== null && existing !== value)
        throw new VaultNotWiredError("Native vault entry differs from the legacy cache; reconcile without overwriting either.");
      await storage.write(value);
      migrated.push({ kind, secretName: storage.name, verified: true });
    }
    if (readFileSync(path, "utf8").trim() !== raw)
      throw new VaultNotWiredError("Legacy credential cache changed during migration; stop writers and reconcile before cutover.");
  }
  return { migrated, originalsPreserved: true as const };
}

export const credentialEnv = (config: Record<string, string | undefined>): NodeJS.ProcessEnv => ({
  ...process.env,
  VUTOOLKIT_CREDENTIAL_STORE: config.VUTOOLKIT_CREDENTIAL_STORE ?? process.env.VUTOOLKIT_CREDENTIAL_STORE,
});
