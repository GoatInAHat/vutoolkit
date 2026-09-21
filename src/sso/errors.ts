/**
 * Typed auth failures. An agent calling a vutoolkit tool sees only the message, so every failure
 * names its code, says whether retrying can help, and says what would fix it. Messages never
 * carry cookie, passkey, or password material.
 */
export type AuthErrorCode =
  /** The managed browser's CDP endpoint could not be reached or started. */
  | "BROWSER_UNAVAILABLE"
  /** A vault secret (VANDERBILT_EMAIL, VANDERBILT_PASSKEY) could not be read. */
  | "VAULT_SECRET_UNAVAILABLE"
  /** OneVU (Okta) rejected the sign-in or showed an error message. */
  | "OKTA_REJECTED"
  /** The OneVU page never reached a state the ceremony recognizes. */
  | "OKTA_FLOW_CHANGED"
  /** The Microsoft sign-in never reached Outlook. */
  | "MICROSOFT_FLOW_CHANGED"
  /** Microsoft sign-in bounced to OneVU because the browser holds no live Okta session. */
  | "OKTA_SESSION_REQUIRED"
  /** The silent OAuth authorize for Graph refused the vaulted session, or the code exchange failed. */
  | "GRAPH_TOKEN_UNAVAILABLE"
  /** A step exceeded its deadline. */
  | "TIMEOUT";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly retryable: boolean;

  constructor(code: AuthErrorCode, message: string, options: { retryable: boolean; cause?: unknown }) {
    super(`[${code}] ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AuthError";
    this.code = code;
    this.retryable = options.retryable;
  }
}

/** Reject with a TIMEOUT AuthError when `work` outlives `ms`; the work itself is not cancelled. */
export async function withDeadline<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AuthError("TIMEOUT", `${step} did not finish within ${Math.round(ms / 1000)}s`, { retryable: true })),
      ms,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
