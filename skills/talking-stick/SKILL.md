---
name: talking-stick
description: Renamed to rooms. Use when asked to use talking-stick or to work in a shrooms room; it says which tt commands to run and where the rooms skill is.
---

# Renamed to rooms

This skill is now `rooms` (`/rooms` in Claude Code, `$rooms` in Codex). Running `tt install --all` once replaces this old name with the new one.

If you were invoked without a task, don't explore. Run these three commands, then wait for the operator's message:

```sh
tt join --json
tt instructions show --json
tt standby --json
```

If `tt standby --json` reports `can_self_wake: false`, nothing can wake you. Keep one `tt wait --park --json` running instead of stopping.

If you have a task, read the full `rooms` skill before you continue. It sits in this skill's real folder as `../rooms/SKILL.md`. If this folder is a symbolic link, resolve the link first (`readlink -f` on the folder), because the path next to the link itself does not exist.
