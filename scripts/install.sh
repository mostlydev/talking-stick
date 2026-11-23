#!/bin/sh
set -eu

repo=mostlydev/shrooms
version=latest
bin_dir="${HOME:?HOME is required}/.local/bin"
install_dir="$HOME/.local/share/talking-stick"
base_url="${TALKING_STICK_RELEASE_BASE_URL:-}"
remove_npm=ask

usage() {
  cat <<'USAGE'
Usage: install.sh [--version VERSION] [--bin-dir DIR] [--install-dir DIR] [--base-url URL] [--remove-npm|--no-remove-npm]

Install the standalone tt binary for macOS or Linux; Node and Bun are not required.
Defaults: latest release, ~/.local/bin/tt, assets in ~/.local/share/talking-stick.
--base-url overrides the release asset URL for local testing or mirrors.
--remove-npm uninstalls a global npm copy of talking-stick without asking.
--no-remove-npm keeps the npm copy without prompting.
USAGE
}
fail() { echo "talking-stick: $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --remove-npm) remove_npm=yes; shift ;;
    --no-remove-npm) remove_npm=no; shift ;;
    --version|--bin-dir|--install-dir|--base-url)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in
        --version) version=$2 ;;
        --bin-dir) bin_dir=$2 ;;
        --install-dir) install_dir=$2 ;;
        --base-url) base_url=$2 ;;
      esac
      shift 2 ;;
    *) fail "unknown option: $1" ;;
  esac
done
case "$(uname -s)" in
  Darwin) target_os=darwin ;;
  Linux) target_os=linux ;;
  *) fail 'standalone installation supports macOS and Linux' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) target_arch=x64 ;;
  arm64|aarch64) target_arch=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac
if [ -z "$base_url" ]; then
  if [ "$version" = latest ]; then
    base_url="https://github.com/$repo/releases/latest/download"
  else
    version=${version#v}
    case "$version" in *[!0-9A-Za-z.-]*|'') fail 'invalid version' ;; esac
    base_url="https://github.com/$repo/releases/download/v$version"
  fi
fi
fetch() {
  case "$1" in
    https://*|http://*) curl -fsSL --retry 3 "$1" -o "$2" ;;
    file://*) cp "${1#file://}" "$2" ;;
    *) cp "$1" "$2" ;;
  esac
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else fail 'sha256sum or shasum is required'; fi
}
task_tmp=$(mktemp -d)
stage_dir=
link_tmp=
trap 'rm -rf "$task_tmp"; [ -z "$stage_dir" ] || rm -rf "$stage_dir"; [ -z "$link_tmp" ] || rm -f "$link_tmp"' EXIT HUP INT TERM
fetch "${base_url%/}/checksums.txt" "$task_tmp/checksums.txt"
suffix="_${target_os}_${target_arch}.tar.gz"
archive=$(awk -v suffix="$suffix" '$2 ~ /^talking-stick_[0-9A-Za-z.-]+_(darwin|linux)_(x64|arm64)\.tar\.gz$/ && substr($2, length($2)-length(suffix)+1) == suffix { print $2 }' "$task_tmp/checksums.txt")
[ -n "$archive" ] || fail "no release for $target_os/$target_arch"
[ "$(printf '%s\n' "$archive" | wc -l | tr -d ' ')" = 1 ] || fail 'ambiguous release manifest'
expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$task_tmp/checksums.txt")
fetch "${base_url%/}/$archive" "$task_tmp/$archive"
[ "$(sha256 "$task_tmp/$archive")" = "$expected" ] || fail "checksum mismatch for $archive"
# Reject paths that could escape the staging directory before extracting.
tar -tzf "$task_tmp/$archive" > "$task_tmp/entries"
if awk '/^\// || /(^|\/)\.\.(\/|$)/ { bad=1 } END { exit !bad }' "$task_tmp/entries"; then
  fail 'unsafe archive paths'
fi
mkdir -p "$install_dir/releases" "$bin_dir"
install_dir=$(cd "$install_dir" && pwd -P)
bin_dir=$(cd "$bin_dir" && pwd -P)
stage_dir=$(mktemp -d "$install_dir/releases/.install.XXXXXX")
tar -xzf "$task_tmp/$archive" -C "$stage_dir"
[ -f "$stage_dir/tt" ] && [ -f "$stage_dir/package.json" ] && [ -f "$stage_dir/skills/talking-stick/SKILL.md" ] || fail 'incomplete release archive'
chmod 0755 "$stage_dir/tt"
"$stage_dir/tt" --help >/dev/null || fail 'binary cannot run on this system'
release_name=${archive#talking-stick_}
release_name=${release_name%"$suffix"}
release_dir="$install_dir/releases/$release_name-$expected"
if [ -d "$release_dir" ]; then
  rm -rf "$stage_dir"
else
  mv "$stage_dir" "$release_dir"
fi
stage_dir=
link_tmp="$bin_dir/.tt-install-$$"
ln -s "$release_dir/tt" "$link_tmp"
mv -f "$link_tmp" "$bin_dir/tt"
link_tmp=
# tt self-update reruns this installer with the same directories.
printf 'bin_dir=%s\n' "$bin_dir" > "$install_dir/install-receipt.tmp"
mv -f "$install_dir/install-receipt.tmp" "$install_dir/install-receipt"
printf 'Installed talking-stick %s to %s/tt\n' "$release_name" "$bin_dir"
case ":${PATH:-}:" in *":$bin_dir:"*) ;; *) printf 'Add %s to PATH.\n' "$bin_dir" ;; esac
on_path=no
case ":${PATH:-}:" in *":$bin_dir:"*) on_path=yes ;; esac
# post-install moves `current` (through which skill links follow every update)
# to this release, re-points managed skill links, and looks for an npm copy.
# A release older than 0.23.1 has none; then only `current` is moved here.
# A release older than 0.23.1 has no post-install; then only a missing
# `current` is created. Any other failure leaves `current` and skills alone.
if ! post=$("$release_dir/tt" post-install --bin-dir "$bin_dir" 2>"$task_tmp/post.err"); then
  post=
  if [ ! -e "$install_dir/current" ] && [ ! -L "$install_dir/current" ]; then
    ln -s "releases/$(basename "$release_dir")" "$install_dir/current"
  elif grep -q 'Unknown command' "$task_tmp/post.err" 2>/dev/null; then
    :
  else
    printf 'Skipped skill-link migration: %s\n' "$(head -n 1 "$task_tmp/post.err")" >&2
  fi
fi
npm_copy=
while IFS= read -r line; do
  case "$line" in
    "pinned "*) printf 'Kept your edited skill %s on its current release.\n' "${line#pinned }" ;;
    "repointed "*) printf 'Updated skill link %s\n' "${line#repointed }" ;;
    "kept "*) printf 'Left skill %s as it is (customized or not ours).\n' "${line#kept }" ;;
    "npm_copy "*) npm_copy=${line#npm_copy } ;;
    "npm_blocked "*) printf 'Not offering to remove the npm copy: %s still uses its skill. Re-run `tt install` after reviewing it.\n' "${line#npm_blocked }" ;;
  esac
done <<POST
$post
POST
if [ -n "$npm_copy" ]; then
  printf 'Found the npm copy of talking-stick at %s.\n' "$npm_copy"
  if [ "$on_path" = no ]; then
    printf 'After adding %s to PATH, remove it with: npm uninstall -g talking-stick\n' "$bin_dir"
  else
    answer=n
    if [ "$remove_npm" = yes ]; then
      answer=y
    elif [ "$remove_npm" = ask ] && (: < /dev/tty) 2>/dev/null && (: > /dev/tty) 2>/dev/null; then
      printf 'Remove the npm copy (npm uninstall -g talking-stick)? [y/N] ' > /dev/tty
      read -r answer < /dev/tty || answer=n
    fi
    case "$answer" in
      y|Y|yes|YES)
        if npm uninstall -g talking-stick; then
          printf 'Removed the npm copy.\n'
        else
          printf 'Could not remove the npm copy; this installation is unaffected. Run: npm uninstall -g talking-stick\n' >&2
        fi ;;
      *) printf 'Kept it. Remove it later with: npm uninstall -g talking-stick\n' ;;
    esac
  fi
fi
resolved_tt=$(command -v tt || true)
if [ -n "$resolved_tt" ] && [ "$resolved_tt" != "$bin_dir/tt" ]; then
  printf 'Your PATH currently selects %s. Put %s first to use this installation.\n' "$resolved_tt" "$bin_dir"
fi
