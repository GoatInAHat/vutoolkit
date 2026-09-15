/**
 * FileSessionStore: the thin, file-backed SessionStore implementation of the vault contract
 * (src/vault/index.ts). One JSON file per data dir, chmod 0600, rows keyed by IdP. Values are
 * written by sessions.ingest and served by sessions.open; nothing else touches them, and no
 * code path logs or echoes cookie material.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VaultNotWiredError, type Idp, type SessionMeta, type SessionStore, type StoredSession } from "./index.js";

/** The cookie fields worth keeping; harvest noise (size, priority, sourceScheme) is dropped. */
export interface CookieRecord {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** CDP epoch seconds; -1 for session cookies. Absent when unknown. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

interface StoreRow extends StoredSession {
  cookies: CookieRecord[];
}

interface StoreFile {
  version: 1;
  rows: Partial<Record<Idp, StoreRow>>;
}

/** Domain suffixes that count as each IdP's session scope. Intentionally short. */
const IDP_DOMAINS: Record<Idp, string[]> = {
  vanderbilt: ["vanderbilt.edu"],
  // The RP cookies (outlook.office.com, outlook.cloud.microsoft) ride with the IdP cookies —
  // live probe 2026-09-15 harvested all of them in one successful outlook.office.com login.
  microsoft: ["microsoftonline.com", "microsoft.com", "live.com", "windows.net", "office.com", "office365.com", "cloud.microsoft"],
};

function belongsToIdp(domain: string, idp: Idp): boolean {
  const host = domain.toLowerCase().replace(/^\./, "");
  return IDP_DOMAINS[idp].some((suffix) => host === suffix || host.endsWith("." + suffix));
}

function sameSite(value: unknown): string | undefined {
  const v = String(value ?? "").toLowerCase();
  return v === "lax" || v === "strict" || v === "none" ? (v === "none" ? "None" : v === "lax" ? "Lax" : "Strict") : undefined;
}

function toRecord(raw: Record<string, unknown>): CookieRecord {
  if (typeof raw.name !== "string" || raw.name === "" || typeof raw.value !== "string") {
    throw new VaultNotWiredError("Harvest contains a cookie without name/value");
  }
  const expires = typeof raw.expires === "number" ? Math.trunc(raw.expires) : undefined;
  return {
    name: raw.name,
    value: raw.value,
    domain: typeof raw.domain === "string" && raw.domain ? raw.domain : undefined,
    path: typeof raw.path === "string" && raw.path ? raw.path : undefined,
    expires: expires !== undefined && expires > 0 ? expires : undefined,
    httpOnly: typeof raw.httpOnly === "boolean" ? raw.httpOnly : undefined,
    secure: typeof raw.secure === "boolean" ? raw.secure : undefined,
    sameSite: sameSite(raw.sameSite),
  };
}

/**
 * Normalize a browser harvest (CDP cookie array, {cookies:[...]}, or {cookieHeader}) into a
 * StoredSession scoped to one IdP. Only cookies in the IdP's domain scope are kept; a harvest
 * with none of them fails closed instead of storing an empty session.
 */
export function harvestToStoredSession(
  idp: Idp,
  raw: unknown,
  acquiredAt: string,
): StoredSession & { cookies: CookieRecord[] } {
  let rows: CookieRecord[] = [];
  let headerOnly: string | undefined;
  if (Array.isArray(raw)) {
    rows = raw.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null).map(toRecord);
  } else if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.cookies)) return harvestToStoredSession(idp, obj.cookies, acquiredAt);
    if (typeof obj.cookieHeader === "string") headerOnly = obj.cookieHeader;
  }
  let scoped: CookieRecord[];
  if (headerOnly !== undefined) {
    // A raw header arrives pre-scoped by construction: the caller asserts its origin.
    scoped = headerOnly.split(";").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 1) throw new VaultNotWiredError("Cookie header contains a malformed pair");
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() } as CookieRecord;
    });
  } else {
    // Array harvests carry per-cookie domains: scope strictly; domain-less rows are noise.
    scoped = rows.filter((c) => (c.domain ? belongsToIdp(c.domain, idp) : false));
  }
  if (scoped.length === 0) {
    throw new VaultNotWiredError(`Harvest holds no ${idp} cookies — nothing ingested`);
  }
  const header = scoped.map((c) => `${c.name}=${c.value}`).join("; ");
  const expiries = scoped.map((c) => c.expires).filter((e): e is number => typeof e === "number");
  const expiresAt = expiries.length ? new Date(Math.max(...expiries) * 1000).toISOString() : undefined;
  const meta: SessionMeta = { idp, acquiredAt, expiresAt, healthy: true };
  return { ...meta, cookieHeader: header, cookies: scoped };
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly filePath: string) {}

  private read(): StoreFile {
    if (!existsSync(this.filePath)) return { version: 1, rows: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new VaultNotWiredError("Session vault file is unreadable or corrupt");
    }
    if (typeof parsed !== "object" || parsed === null) throw new VaultNotWiredError("Session vault file is corrupt");
    return parsed as StoreFile;
  }

  private write(file: StoreFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    try { chmodSync(this.filePath, 0o600); } catch { /* best-effort on filesystems without chmod */ }
  }

  async list(): Promise<SessionMeta[]> {
    const { rows } = this.read();
    return Object.values(rows).map(({ idp, acquiredAt, expiresAt, healthy }) => ({ idp, acquiredAt, expiresAt, healthy }));
  }

  async get(idp: Idp): Promise<StoredSession | null> {
    const row = this.read().rows[idp];
    if (!row) return null;
    return { idp: row.idp, acquiredAt: row.acquiredAt, expiresAt: row.expiresAt, healthy: row.healthy, cookieHeader: row.cookieHeader };
  }

  async put(session: StoredSession & { cookies?: CookieRecord[] }): Promise<void> {
    const file = this.read();
    file.rows[session.idp] = { ...session, cookies: session.cookies ?? [] };
    this.write(file);
  }

  async forget(idp: Idp): Promise<void> {
    const file = this.read();
    if (!(idp in file.rows)) return;
    delete file.rows[idp];
    this.write(file);
  }

  /** Cookie objects for a stored IdP session, for the cdp/storage-state payload formats. */
  cookies(idp: Idp): CookieRecord[] {
    return this.read().rows[idp]?.cookies ?? [];
  }
}
