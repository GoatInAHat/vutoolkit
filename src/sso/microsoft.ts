/**
 * SSO -> Microsoft chain (build order step 2): an established Vanderbilt SSO browser session
 * reaches login.microsoftonline.com via the IdP-initiated flow; the exchange yields Microsoft
 * session cookies and Graph access without a second credential. Implemented when live probing
 * opens; until then the operation stays honestly gated.
 */
export class MicrosoftNotConfiguredError extends Error {}

export async function microsoftSessionFromSso(_opts: { ssoCookieHeader: string }): Promise<never> {
  throw new MicrosoftNotConfiguredError(
    "gated on credentials: SSO-to-Microsoft chain lands with live probing (build order step 2)",
  );
}
