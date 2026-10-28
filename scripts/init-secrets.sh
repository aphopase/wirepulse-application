#!/bin/sh
# Usage: init-secrets.sh [directory]   (default: ./secrets; if you choose another, set WIREPULSE_SECRETS_DIR to it)
# Creates a random database password (hex, so it needs no URL-encoding). Never overwrites.
set -eu
dir="${1:-$(cd "$(dirname "$0")/.." && pwd)/secrets}"
if [ -e "$dir/postgres_password" ] || [ -e "$dir/database_url" ]; then
  echo "refusing to overwrite existing files in $dir" >&2
  exit 1
fi
umask 077
mkdir -p "$dir"
password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s' "$password" > "$dir/postgres_password"
printf 'postgresql://wirepulse:%s@postgres:5432/wirepulse' "$password" > "$dir/database_url"
# The containers run as non-root users and read these through a bind mount, so the files must be world-readable;
# the 0700 directory is what keeps other users on this host out.
chmod 644 "$dir/postgres_password" "$dir/database_url"
echo "created $dir/postgres_password and $dir/database_url"
