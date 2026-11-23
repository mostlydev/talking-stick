# Release shrooms

1. Review `CHANGELOG.md` against the last release tag. Put upgrade steps and changed or removed
   commands under **Unreleased**. Write local links relative to the repository root and keep
   inline code on one line. Put multi-line examples in fenced blocks.
2. On a release branch, run `npm version <new-version> --no-git-tag-version`. The version script
   moves the entries into the version section, generates `docs/releases/<version>.md`, and rebases
   local links. Review the generated files and run the [development checks](../README.md#development).
3. Open a release PR and get independent review and green CI for the candidate. Merge the PR.
   Verify the version and CI on the exact merge commit before pushing an annotated
   `v<version>` tag for it.
4. Wait for the **Release** workflow. It builds and smoke-tests five targets (macOS and Linux
   on x64 and arm64, plus Windows x64) and publishes the archives and `checksums.txt` to GitHub.
5. Check the tag target, assets, and checksums. Install the matching platform archive in
   temporary locations and run `tt --version`. For a standalone update check, install the
   previous release there, run `tt self-update`, and verify the active version and skill links.

GitHub is the distribution channel for standalone releases. The npm package stopped updating
after 0.23.0.

## Harness support

Claude Code, Codex, Grok Build, and Antigravity are the supported toolchains.
CI checks that each installs both packaged skills and its native lifecycle hook,
and provides a supervisor adapter for startup, prompting, resuming, and cancellation
on platforms that support managed process groups.

When a release changes a toolchain, check it with the real harness in a temporary
room. Install the skills and hooks into a test profile. Open the room in `tt chat`,
invoke the room skill, and verify that the member appears. Start a managed worker,
send a room message, and verify the worker's reply and return to idle. Restart the
worker and verify that it keeps the same conversation.

Workspace skill paths and global paths can differ. See [Install and update](install.md)
for the locations used by shrooms.
