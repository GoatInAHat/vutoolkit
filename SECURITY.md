# Security

vutoolkit handles student records and credentials for Vanderbilt and Microsoft services. Deploy it only for an account you own or are authorized to operate.

## Credential handling

- Keep passkeys in the host secret vault or another secret manager; inject standalone credentials through the process environment.
- Keep per-account data directories separate. Cached sessions and Graph tokens grant access to the account and are stored in permission-restricted local files.
- Treat `sessions.open` output as secret authentication material. It intentionally exposes a usable session payload to an authorized consumer.
- Do not expose the local MCP listener or Chromium CDP endpoint to an untrusted network. Use the generated MCP pairing/authentication mechanism for extension clients.
- Do not publish transcripts, email content, cookie exports, debug traces containing tokens, or real credential fixtures.

## Account actions

Academic-record and GPA operations are read-only. Microsoft Graph supports writes as well as reads; an agent must act within the account holder's authorization. Cached authentication is not permission to send messages, change enrollment, or perform other unrelated actions.

The browser extension's user-selected cart controls add or remove cart entries, never enroll or drop classes. First-time `setup.enroll` changes account security by adding a passkey, requires explicit confirmation, and refuses to overwrite an existing toolkit key. A configured key or a locally cached session is not evidence that the identity provider still accepts it.

## Reporting a vulnerability

Do not post credentials or personal student data in a public issue. Use GitHub's private vulnerability reporting option on the repository's **Security** tab when available. If it is unavailable, open an issue requesting a private reporting channel without including exploit details or private data.

Include the affected version, the smallest sanitized reproduction, and the expected impact. Delete secrets from any diagnostic material before sharing it.


## Registry scan review

ClawHub flags the v0.4.0 native package as **suspicious**. A manual source review explains several reported patterns: browser discovery and the web launcher use fixed executable/argument arrays; bundled schema validators use dynamic compilation; authentication necessarily reads configured credentials and communicates with the identity provider; professor lookup uses a public-service client header, not a student's Vanderbilt credentials. This explanation does not override the registry's verdict or constitute a comprehensive security audit.

The important intentional privileges remain: `sessions.open` exports usable authentication material and `graph.call` permits real Microsoft account writes. Restrict these operations to trusted clients; the calling host/agent must enforce account-holder authorization. Installing the skill or seeing passing tests does not grant that authorization.
