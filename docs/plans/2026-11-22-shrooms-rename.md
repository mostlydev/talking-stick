# Rename the project to Shrooms

**Status** · Proposed

**Shrooms** is the product and repository name. It stands for shell rooms. A room gives agents a place to coordinate with operators and orchestrators. The **talking stick** is the feature that gives one agent at a time permission to edit a shared workspace.

## Compatibility contract

| Surface | First Shrooms release |
| --- | --- |
| GitHub | Rename the existing repository in place to `mostlydev/shrooms` so issues, PRs, tags, and history stay together. Verify redirects and update the URLs we control. |
| CLI | Keep `tt` installed and supported. Add `rooms` as the second name of the same executable once packaging and hooks can prove same-state behavior. `rooms` and `tt` are the only installed commands; there is no `shrooms` command. Hooks and skills keep calling `tt`. |
| Rooms and data | Keep the existing data directories, SQLite files, supervisor state and service label, room pins, and `.talking-stick/` project files. Preserve room IDs, leases, history, and the current checkout-to-room mapping. The default standalone install and data share a directory on macOS and Linux. Keep both the `current` link and `rooms.sqlite` there. |
| Environment and integrations | Keep `TT_ROOM`, `TALKING_STICK_DATA_DIR`, existing hook entry points and installer ownership markers, supervisor environment variables, the `[talking-stick]` wake envelope, the Herdr plugin ID `talking-stick.chat`, and the ack-link host `talking-stick.invalid`. Add aliases only when precedence is explicit and both names select identical state. |
| Skills | In 0.39 the skills become `rooms` and `rooms-oversee`, as the operator asked. Release archives keep `skills/talking-stick/SKILL.md` (and `talking-stick-rooms`) as redirect stubs, because installers from 0.38.0 and earlier refuse an archive without that file; the stubs are never installed. Post-install and startup sync move installs under the old names only when they are unedited links or copies made by Shrooms, after checking the new location is free, and keep customized ones. |
| Releases | Publish legacy `talking-stick_<version>_<platform>.tar.gz` names and the old checksum format through the transition. Keep npm package detection for historical installs. |

## Rollout

1. **Prepare a bridge release under the current repository name.** Update README, help, examples, and the skill descriptions to use Shrooms as the product name. Audit the old GitHub and raw URLs in the installer, self-updater, release-status checker, package metadata, workflows, and docs. Teach supported updaters to find the canonical repo and the legacy release assets. Ship the bridge with the legacy install paths and asset names.
2. **Test the public rename path before cutover.** Use a disposable repo rename or published release fixture to check Git fetch, issues and PR links, raw installer URLs, release asset downloads, and update polling. Test a v0.36.0 upgrade as well as the bridge release upgrade. A local Git redirect does not prove that the raw installer or checksum URL redirects. If a legacy URL breaks, document and test the canonical installer as the recovery path before switching.
3. **Rename the existing repository in place.** Verify control of the destination name, use the GitHub repository rename, then update canonical links, release tooling, and maintained remote references. Check historical tags, open work, and CI. Audit GitHub Pages and any workflows that call actions in this repository by name, since GitHub excludes those from redirects. Keep the old repository name unused so redirects can continue. [GitHub repository rename behavior](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
4. **Add ergonomic aliases after cutover.** Test that `tt` and `rooms` see the same room, acquire the same stick, and update the same installation. Keep legacy asset labels until old updaters can parse the new ones or support both. Windows needs its own manually extracted archive and alias check.
5. **Treat any on-disk path rename as a later migration.** It needs its own compatibility policy and test matrix, including old/new command coexistence, interruption, rollback, and an active supervisor. Never open two writable databases for one profile. Keeping the existing storage paths is a valid end state.

## Existing installations must migrate seamlessly

Treat compatibility as a release gate. Test direct upgrades from the currently published installers as well as upgrades from the bridge. Cover standalone macOS and Linux, manual Windows archive replacement, historical npm installs, and linked development checkouts. Carry forward the command, room database and IDs, worker state, service registration, hooks, and customized skill links. Prove that old hard-coded update endpoints work after a disposable repository rename. Defer the production rename if a supported existing upgrade path would strand an installation.

After a successful upgrade, show one human-readable notice in the console updater or on the next interactive `tt` or `tt chat` launch. Example: “Talking Stick is now Shrooms. Keep using `tt`. Your rooms and settings carried over.” Share one durable notice marker per local user profile across consoles. Keep JSON, hooks, harness output, and wake envelopes unchanged. A failed or rolled-back update leaves the notice pending. Test the notice exactly once across restart, concurrent terminals, and self-update followed by chat.

## Acceptance

A fresh Shrooms install opens a room. An upgrade from the public Talking Stick release preserves its room history, declared room routing, worker records, and installed skill links. Existing `tt` scripts and hooks continue to work. A single profile has one database and supervisor across both command names. Old GitHub links and the updater either work through the transition or point to a tested recovery path. Run these checks on macOS, Linux, and Windows where the surface exists before announcing the rename.
