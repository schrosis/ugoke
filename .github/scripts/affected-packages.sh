#!/usr/bin/env bash
# Selects the workspace packages that CI must check.
#
# Usage: affected-packages.sh [BASE_REF]
#
# Writes these outputs to $GITHUB_OUTPUT, or to standard output when it is unset:
#   scope        all, affected, or none
#   build_args   pnpm arguments that select packages to build, including dependencies
#   check_args   pnpm arguments that select packages to check
#   temporal_cli true when the pinned Temporal CLI must be checked against its release
#   specs        true when the FSL specifications must be checked
set -euo pipefail

base="${1:-}"
output="${GITHUB_OUTPUT:-/dev/stdout}"

temporal_cli=false
specs=false

write() {
  printf 'scope=%s\nbuild_args=%s\ncheck_args=%s\ntemporal_cli=%s\nspecs=%s\n' \
    "$1" "$2" "$3" "$temporal_cli" "$specs" >> "$output"
}

# Selective runs rely on these scripts, so a package without one would be
# skipped silently.
missing="$(
  pnpm -r ls --depth -1 --json \
    | jq -r '.[] | select(.path | test("/packages/[^/]+$")) | .name' \
    | while IFS= read -r name; do
        pnpm --filter "$name" exec node -e '
          const { scripts = {} } = require("./package.json");
          const missing = ["build", "lint", "test", "typecheck"].filter((name) => !scripts[name]);
          if (missing.length > 0) console.log(`${process.argv[1]}: ${missing.join(", ")}`);
        ' "$name"
      done
)"
if [ -n "$missing" ]; then
  printf 'Packages without required scripts:\n%s\n' "$missing" >&2
  exit 1
fi

if [ -z "$base" ]; then
  temporal_cli=true
  specs=true
  write all "-r" "-r"
  exit 0
fi

# Documentation changes do not require package checks.
docs_pattern='^(docs/|\.claude/)|\.md$|^LICENSE$'
root_changed=false
packages_changed=false
while IFS= read -r file; do
  # The check downloads from GitHub, so run it only when the pinned release can change.
  if [[ $file == packages/cli/src/temporal-cli/manifest.ts || $file == scripts/update-temporal-cli.ts ]]; then
    temporal_cli=true
  fi
  # The specifications are checked with the fslc that mise pins.
  if [[ $file == specs/* || $file == .github/scripts/check-specs.sh || $file == mise.toml || $file == mise.lock ]]; then
    specs=true
  fi
  # Specifications and documentation do not require package checks.
  if [[ $file == specs/* ]]; then
    continue
  fi
  if [[ $file =~ $docs_pattern ]]; then
    continue
  elif [[ $file == packages/* ]]; then
    packages_changed=true
  else
    root_changed=true
  fi
done < <(git diff --name-only "$base...HEAD")

if $root_changed; then
  write all "-r" "-r"
elif $packages_changed; then
  build_args=""
  check_args=""
  while IFS= read -r name; do
    build_args+="--filter=$name... "
    check_args+="--filter=$name "
  done < <(
    pnpm --filter "...[$base]" --changed-files-ignore-pattern '**/*.md' ls -r --depth -1 --json \
      | jq -r '.[] | select(.path | test("/packages/[^/]+$")) | .name'
  )
  write affected "${build_args% }" "${check_args% }"
else
  write none "" ""
fi
