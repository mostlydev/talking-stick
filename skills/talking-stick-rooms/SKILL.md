---
name: talking-stick-rooms
description: Renamed to rooms-oversee. Use to check on shrooms rooms from outside; it says which tt commands to run and where the rooms-oversee skill is.
---

# Renamed to rooms-oversee

This skill is now `rooms-oversee`. Running `tt install --all` once replaces this old name with the new one.

To see what rooms are doing without joining any of them:

```sh
tt room list --all --json
tt room brief <room> --json
```

For anything more, read the full `rooms-oversee` skill. It sits in this skill's real folder as `../rooms-oversee/SKILL.md`. If this folder is a symbolic link, resolve the link first (`readlink -f` on the folder), because the path next to the link itself does not exist.
