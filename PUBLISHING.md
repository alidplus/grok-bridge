# Publishing Grok Bridge

Grok Bridge is published to [Open VSX](https://open-vsx.org) as `alidplus.grok-bridge`.
The `publisher` field in `package.json` must be exactly `alidplus`. Open VSX checks the case of the
namespace when it accepts a trusted-publishing token.

## One-time setup

1. **Create the GitHub repo.** Ali creates `https://github.com/alidplus/grok-bridge` **empty**: no README,
   no license and no .gitignore, so nothing conflicts with the local history. Then push the local repo:
   ```bash
   git remote add origin git@github.com:alidplus/grok-bridge.git
   git push -u origin main
   ```
2. **Set up the Open VSX account and namespace.**
   - Sign in at open-vsx.org with GitHub (alidplus) and link an eclipse.org account.
   - Sign the **Publisher Agreement**, found in Settings → Profile.
   - Create the `alidplus` namespace, either in the web UI or with `npx ovsx create-namespace alidplus -p <token>`.
     Ali must be an **owner** of the namespace.
3. **Publish the first version the ordinary way.** A trusted publisher can only be registered once the extension exists.
   - Build it with `npx @vscode/vsce package`, which produces `grok-bridge-<version>.vsix`.
   - Upload it on open-vsx.org (Settings → Extensions → Publish), **or** run
     `npx ovsx publish grok-bridge-<version>.vsix -p <access token>`. Create the token under Settings → Access Tokens and delete it afterwards.
4. **Register the trusted publisher** on open-vsx.org under Settings → Trusted Publishers. Choose namespace `alidplus` and provider GitHub Actions:
   - Organization or User name: `alidplus`
   - Repository name: `grok-bridge`
   - Workflow filename: `publish.yml`
   - Environment name: `publish`
5. **Create the `publish` environment** on GitHub under Repo → Settings → Environments → New environment `publish`.
   Add **Ali (alidplus)** as the required reviewer. Optionally, limit deployment to tags matching `v*`.

## Releasing (every time after the first)

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`. Also bump `SDK_VERSION` in
   `sdk-installer.js` if the SDK should move to a newer version.
2. Commit, then tag and push:
   ```bash
   git tag v0.1.2 && git push origin main v0.1.2
   ```
3. The **Publish to Open VSX** workflow runs, waits for Ali's approval on the `publish` environment, publishes
   with `ovsx publish --trusted-publishing` (no token needed), and attaches the vsix to the GitHub release.
   The workflow fails if the tag doesn't match the `package.json` version.

`workflow_dispatch` lets you rerun a publish by hand. Open VSX rejects a version that is already published.
