# Release engineering

`plugin.json` owns the version. Tool Factory generates the package metadata, host surfaces, CI, and release workflow from the authored operation module and `dev.toolfactory/tool.json`.

## Release gates

1. Reconcile the requested features against [SPEC.md](SPEC.md). Record unfinished work honestly; a passing scaffold validator is not feature-completion evidence.
2. Run the unit suite, TypeScript build, Tool Factory drift check, and selected surface validators. Use `npx toolfactory gate` for the native combined gate.
3. Run the explicit live suite with the release account. Verify the account identity, both session chains, academic record, official GPA comparison, and read-only Graph calls. Keep the report to pass/fail and sanitized counts; never attach private account data to a release.
4. Build packages with `npx toolfactory package`. Inspect the npm and OpenClaw tarballs, verify built web assets are present, and test installation outside the checkout. Host tarballs must reference the released core version, not `file:../..`.
5. Commit the release inputs and generated changes, then tag the intended commit. A failed or skipped registry job is not a successful publication.
6. Verify the npm version and provenance, ClawHub package/skill entries, GitHub release assets, and installed runtime versions independently. Test each installed host against its own account.
7. Submit the extension to the browser stores (Chrome Web Store, Firefox Add-ons, Edge Add-ons) following the [browser store submission](#browser-store-submission) procedure below. A pending or rejected review is a failed gate, the same as a failed registry job — it is not a successful publication until each store's dashboard shows the listing live.

Do not reuse an already-published version for changed package contents.

## npm trusted publishing

Use GitHub Actions OIDC for ongoing releases. The publisher configuration must match:

| Setting | Value |
| --- | --- |
| GitHub owner | `GoatInAHat` |
| Repository | `vutoolkit` |
| Workflow filename | `release.yml` |
| Allowed action | Direct `npm publish`, if using the generated release workflow |
| Runner | GitHub-hosted runner |

npm's current documentation requires Node.js 22.14+ and npm 11.5.1+ for OIDC publishing. `npm trust` configuration requires npm 11.15+, an existing registry package, package write access, and an interactive account with 2FA. New trusted publishers may default to staged publishing, so direct publication must be explicitly allowed.

**First publication is a separate bootstrap step.** npm requires the package to exist before a trusted publisher can be configured. An authorized maintainer must perform the initial publish using their authenticated npm session or another supported existing credential. After the package exists, configure trust from the maintainer's authenticated session:

```sh
npm trust github vutoolkit --file release.yml --repo GoatInAHat/vutoolkit --allow-publish
gh variable set NPM_TRUSTED_PUBLISHER --body true --repo GoatInAHat/vutoolkit
```

Set the GitHub variable only after trust is configured successfully. The publishing job needs `id-token: write`; no long-lived npm token is needed for subsequent OIDC releases. Public GitHub-to-public-npm OIDC releases generate provenance automatically.

Tool Factory's `bootstrap-repo` can prepare the GitHub settings and reports any account-level steps it cannot complete. Never paste authentication tokens or 2FA codes into repository files, command arguments, or issue comments.

Official references: [trusted publishers](https://docs.npmjs.com/trusted-publishers/) and [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust).

## ClawHub

Select the `clawhub` surface alongside `skill` and `openclaw-native` so Tool Factory generates the relevant publication jobs. Use the supported ClawHub authentication flow and supply the release credential through the host secret store or GitHub Actions secrets. Publishing the skill alone does not establish that the native plugin package is available, and vice versa.

After publication, inspect both entries and install the native plugin through the same public path a new user would use. Verify operation registration and authenticated account identity on the destination host.

## Browser store submission

The `hosts/browser` extension ships to three stores from one WXT codebase (see [TARGETS.md](../hosts/browser/TARGETS.md)): Chrome Web Store and Edge Add-ons both install the same Chromium MV3 build, Firefox Add-ons needs the separate Firefox build and manifest.

1. Build the per-engine packages after the version bump and before tagging: `npm --prefix hosts/browser run zip` (Chromium — Chrome and Edge) and `npm --prefix hosts/browser run zip:firefox`. Inspect each zip's `manifest.json` for the version before uploading.
2. Use the listing copy already written for each store in [STORE-LISTINGS.md](STORE-LISTINGS.md) (title, description, category, permission justifications, search terms as applicable). Do not hand-write new copy at submission time.
3. Confirm every item in [`hosts/browser/ASSETS.md`](../hosts/browser/ASSETS.md)'s "before any store submission" checklist is satisfied first: a real, non-placeholder icon set at all five manifest sizes, a 300×300 Store logo for Edge, at least one 1280×800 screenshot, and a privacy-policy URL pinned to the release tag (e.g. `https://github.com/GoatInAHat/vutoolkit/blob/vX.Y.Z/docs/PRIVACY.md`, not `main`, so the text a reviewer approves can't drift under the link afterward). None of these block the extension's own build or test suite; all four block a store from accepting the submission.
4. Submit through each store's own developer dashboard (Chrome Web Store Developer Dashboard, Firefox Add-on Developer Hub, Microsoft Partner Center) using an account-holder's authenticated session. This step is manual and cannot be scripted or delegated to CI; it also carries each store's own one-time developer registration step (Chrome: a one-time developer-registration fee; Edge and Firefox: a free developer account).
5. Record the submission date, review outcome (approved/rejected/pending), and the published listing URL for each store in [ACCEPTANCE.md](ACCEPTANCE.md). A pending review is not a completed gate; report it as pending, never as passed.
6. After a store approves the listing, install it from that store — not from an unpacked or locally built package — on a clean browser profile, and verify the extension loads, pairs with a local kernel, and the YES content script mounts. This is the cross-browser installation verification the acceptance record expects, distinct from the unpacked-build checks `npx toolfactory validate` already covers.

Each store reviews independently: a rejection on one does not block submitting to, or publishing on, the other two. Do not resubmit a rejected version without recording why it was rejected and what changed.

## Live tests and private accounts

Tool Factory provides a separate live-test tier. Credentials should be resolved by the host's vault-backed runner, not checked into the repository or copied into fixtures. Default CI must remain credential-free; opt-in live CI requires an appropriately configured protected environment. A skipped live suite must be reported as skipped, never passed.

Run `npm run test:live` on a configured host. The runner enables `VUTOOLKIT_LIVE` for the child test process; the operations continue to resolve authentication through the existing host vault. The Tool Factory `tests.live` configuration generates the opt-in guard, while `ci: false` keeps this local-vault suite out of hosted CI and avoids copying account credentials into GitHub secrets.
