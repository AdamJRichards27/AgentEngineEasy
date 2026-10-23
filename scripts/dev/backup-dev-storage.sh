#!/usr/bin/env bash
# CC #52 (Owner t465u decision 3): backup for the DEV-ONLY local object store
# (OBJECT_STORAGE_PROVIDER=local, OBJECT_STORAGE_LOCAL_DIR). Branding images
# and other local documents live there, outside the Postgres dump.
#
#   backup:  scripts/dev/backup-dev-storage.sh backup [STORAGE_DIR] [BACKUP_DIR]
#   verify:  scripts/dev/backup-dev-storage.sh verify ARCHIVE.tar.gz
#
# - Refuses to run when NODE_ENV=production or OBJECT_STORAGE_PROVIDER is not local.
# - Archive + .sha256 are written with umask 077 (owner-only, 0600) into a
#   0700 directory that must be outside the git tree.
# - verify re-hashes the archive, checks the tarball lists and that every
#   member is a regular file or directory (no symlinks/devices/absolute or
#   ../ paths), and compares the file count against the manifest.
# - Never prints file contents or secrets. Does not restore anything.
set -euo pipefail
umask 077

die() { echo "backup-dev-storage: $*" >&2; exit 1; }

guard_env() {
  [ "${NODE_ENV:-}" = "production" ] && die "refusing: NODE_ENV=production (local storage is dev-only)"
  local provider="${OBJECT_STORAGE_PROVIDER:-local}"
  [ "${provider,,}" = "local" ] || die "refusing: OBJECT_STORAGE_PROVIDER=$provider is not local"
}

inside_git_tree() {
  git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

backup() {
  guard_env
  local src="${1:-${OBJECT_STORAGE_LOCAL_DIR:-./storage}}"
  local dest="${2:-${DEV_STORAGE_BACKUP_DIR:-$HOME/.ae-dev-storage-backups}}"
  [ -d "$src" ] || die "storage directory not found: $src"
  src="$(cd "$src" && pwd -P)"
  mkdir -p "$dest"
  chmod 700 "$dest"
  dest="$(cd "$dest" && pwd -P)"
  case "$dest/" in "$src/"*) die "backup directory must not be inside the storage directory";; esac
  if inside_git_tree "$dest"; then
    rmdir "$dest" 2>/dev/null || true
    die "backup directory must be outside any git working tree: $dest"
  fi
  local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local base="$dest/dev-storage-$stamp"
  local files; files="$(find "$src" -type f | wc -l | tr -d ' ')"
  local links; links="$(find "$src" -type l | wc -l | tr -d ' ')"
  [ "$links" = "0" ] || die "storage contains $links symlink(s); refusing to archive"
  tar --create --gzip --file "$base.tar.gz" --directory "$src" --numeric-owner --no-acls --no-xattrs .
  chmod 600 "$base.tar.gz"
  ( cd "$dest" && sha256sum "$(basename "$base.tar.gz")" > "$(basename "$base.tar.gz").sha256" )
  printf 'source=%s\ncreated_utc=%s\nfiles=%s\n' "$src" "$stamp" "$files" > "$base.manifest"
  chmod 600 "$base.tar.gz.sha256" "$base.manifest"
  echo "archive=$base.tar.gz"
  echo "sha256=$(cut -d' ' -f1 "$base.tar.gz.sha256")"
  echo "files=$files"
  verify "$base.tar.gz"
}

verify() {
  local archive="${1:-}"
  [ -f "$archive" ] || die "archive not found: $archive"
  local sumfile="$archive.sha256" manifest="${archive%.tar.gz}.manifest"
  [ -f "$sumfile" ] || die "checksum file missing: $sumfile"
  ( cd "$(dirname "$archive")" && sha256sum --check --status "$(basename "$sumfile")" ) || die "CHECKSUM MISMATCH: $archive"
  local perms; perms="$(stat -c %a "$archive")"
  [ "$perms" = "600" ] || die "archive permissions are $perms, expected 600"
  local listing; listing="$(tar --list --verbose --gzip --file "$archive")" || die "archive is unreadable"
  if printf '%s\n' "$listing" | awk '{print substr($1,1,1)}' | grep -qv '^[-d]$'; then
    die "archive contains a non-regular member (symlink/device)"
  fi
  if tar --list --gzip --file "$archive" | grep -Eq '^/|(^|/)\.\.(/|$)'; then
    die "archive contains an absolute or parent-relative path"
  fi
  local count; count="$(printf '%s\n' "$listing" | awk 'substr($1,1,1)=="-"' | wc -l | tr -d ' ')"
  if [ -f "$manifest" ]; then
    local expected; expected="$(sed -n 's/^files=//p' "$manifest")"
    [ "$count" = "$expected" ] || die "file count $count does not match manifest $expected"
  fi
  echo "verify=OK files=$count sha256=$(cut -d' ' -f1 "$sumfile")"
}

case "${1:-}" in
  backup) shift; backup "$@" ;;
  verify) shift; verify "$@" ;;
  *) echo "usage: $0 backup [STORAGE_DIR] [BACKUP_DIR] | verify ARCHIVE.tar.gz" >&2; exit 2 ;;
esac
