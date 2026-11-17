# Release Talking Stick

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
