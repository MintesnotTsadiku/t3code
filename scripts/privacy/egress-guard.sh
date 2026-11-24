#!/usr/bin/env bash
# Fail when a built T3 Code runtime still holds a product telemetry endpoint or key.
#
# Usage: scripts/privacy/egress-guard.sh <t3-<ver>-<platform>-<arch>.tar.gz | extracted dir>
#
# The guard scans every file, binary files too: the `t3` single executable embeds
# the server bundle, so a text-only scan would miss it. It prints each match with
# its file and exits 1 when it finds one.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <runtime tarball or directory>" >&2
  exit 2
fi

target="$1"
scratch=""
cleanup() {
  if [[ -n "$scratch" ]]; then rm -rf "$scratch"; fi
  if [[ -n "${allowed:-}" ]]; then rm -f "$allowed"; fi
}
trap cleanup EXIT

if [[ -f "$target" ]]; then
  scratch="$(mktemp -d)"
  tar -xzf "$target" -C "$scratch"
  root="$scratch"
elif [[ -d "$target" ]]; then
  root="$target"
else
  echo "egress-guard: $target is not a file or directory" >&2
  exit 2
fi

# kind|name|extended regex. Kind "key" never prints the match, only the files.
patterns=(
  "host|T3 ingest host|ingest\.t3\.codes"
  "key|PostHog project key|phc_[A-Za-z0-9]{20,}"
  "host|PostHog host|posthog\.com"
  "host|Axiom host|[A-Za-z0-9.-]*axiom\.co\b"
  "key|Axiom API token|xaat-[A-Za-z0-9-]{8,}"
  "key|Axiom personal token|xapt-[A-Za-z0-9-]{8,}"
)

# Fixed strings for host matches that were reviewed and are not telemetry.
allowed="$(mktemp)"
grep -v '^#' "$(dirname "$0")/egress-allow.txt" 2>/dev/null | sed '/^$/d' > "$allowed" || true

file_count="$(find "$root" -type f | wc -l)"
echo "egress-guard: scanning $file_count files under $(basename "$target")"

found=0
for entry in "${patterns[@]}"; do
  kind="${entry%%|*}"
  rest="${entry#*|}"
  name="${rest%%|*}"
  regex="${rest#*|}"
  # -a: treat binaries as text. Keys print only the file. Hosts print the match
  # with some context, minus the reviewed contexts in egress-allow.txt.
  if [[ "$kind" == "key" ]]; then
    matches="$(grep -ralE -- "$regex" "$root" 2>/dev/null | sed "s|^$root/||" | sort | head -n 20 || true)"
  else
    matches="$(grep -raoE -- ".{0,40}($regex).{0,40}" "$root" 2>/dev/null \
      | LC_ALL=C tr -c '[:print:]\n' '?' \
      | grep -vF -f "$allowed" \
      | sed "s|^$root/||" | sort | uniq -c | head -n 20 || true)"
  fi
  if [[ -n "$matches" ]]; then
    found=1
    echo "FOUND $name ($regex):"
    echo "$matches" | sed 's/^/  /'
  else
    echo "clean $name"
  fi
done

if [[ "$found" -ne 0 ]]; then
  echo "egress-guard: FAILED"
  exit 1
fi
echo "egress-guard: PASSED"
