# Contributing

vutoolkit is an independent toolkit for students and their authorized AI agents. Start with the [original specification](docs/SPEC.md) and [agent development guide](AGENTS.md).

## Local development

Use Node.js 22.14 or later, npm, and a clean checkout:

```sh
npm ci
npm test
npm run build
npx toolfactory check
```

The web app has its own dependency lockfile. Use `npm --prefix web ci` and `npm --prefix web run build` for web changes.

After building both the web app and browser extension, run `node --import tsx scripts/test-yes-browser.mjs` from the repository root for browser acceptance against synthetic fixtures. The optional `VUTOOLKIT_LIVE=1` mode additionally checks mounting on an authenticated YES page while blocking mutation requests; it does not test live cart changes or passkey issuance.

## Generated files

Package identity belongs in `plugin.json`; operations belong in `src/ops.ts` and their implementation modules. After changing operation definitions, run `npx toolfactory introspect` and `npx toolfactory build`. After changing the Tool Factory configuration, rebuild and run the drift check.

Do not hand-edit generated blocks, schemas, host manifests, or release workflows. Fix the generator, change the authored inputs, or explicitly adopt the affected file with Tool Factory. README and skill prose outside their generated blocks remain author-owned.

## Tests and pull requests

- Add focused regression coverage for behavior changes, especially authentication, GPA arithmetic, and record parsing.
- Use synthetic or thoroughly redacted fixtures. Never commit a real transcript, mailbox, cookie export, passkey, or access token.
- Identify which checks ran and which were skipped. Do not claim live coverage from fixture tests.
- Keep live checks read-only unless the account holder explicitly authorizes a particular write.
- Keep the feature status accurate: scaffolding and generated surfaces do not demonstrate completion of a user-facing feature.

Report bugs through [GitHub issues](https://github.com/GoatInAHat/vutoolkit/issues), with versions, reproduction steps, and sanitized errors. For security-sensitive findings, follow [SECURITY.md](SECURITY.md).
