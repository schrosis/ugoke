#!/usr/bin/env bash
# Checks and verifies the FSL specifications in specs/.
#
# A check that passes with warnings fails here, so that every declaration keeps a requirement ID.
#
# A file named *.refines.fsl maps one specification onto another. Its line
# `// refine: <impl>.fsl <abs>.fsl` names the two, relative to specs/, and fslc refine checks it.
#
# fslc mutate is not run here, because it takes too long. Run it by hand on a requirements file
# that you change, if it has up to about 500 mutants:
#   fslc mutate --depth 6 --max-mutants 100000 specs/<file>.fsl
# Without --max-mutants, it tries only the first 200 mutants. A heavier file, such as
# specs/workflow-transitions.fsl, is not mutated; check it with copies that you break on purpose.
set -euo pipefail

shopt -s nullglob
specs=()
refinements=()
for file in specs/*.fsl; do
  case "$file" in
    *.refines.fsl) refinements+=("$file") ;;
    *) specs+=("$file") ;;
  esac
done
if [ "${#specs[@]}" -eq 0 ]; then
  echo "No specifications to check"
  exit 0
fi

for spec in "${specs[@]}"; do
  echo "::group::$spec"
  fslc check --strict-tags "$spec" | jq -e '.result == "ok" and (.warnings | length) == 0' > /dev/null || {
    fslc check --strict-tags "$spec" || true
    echo "::error file=$spec::fslc check failed or reported warnings"
    exit 1
  }
  fslc lint "$spec" > /dev/null || {
    fslc lint "$spec" || true
    echo "::error file=$spec::fslc lint reported findings"
    exit 1
  }
  # The explicit engine explores every state and proves the spec when the exploration closes
  # within the depth, which covers the longest run of every spec here.
  # A spec it cannot explore, such as one with a leadsTo, falls back to bounded BMC, and then
  # induction must prove the invariants. A state where nothing can happen and that the spec does
  # not declare terminal fails.
  result=$(fslc verify --engine auto --deadlock error --depth 32 "$spec" | jq -r '.result') || true
  case "$result" in
    proved) ;;
    verified)
      fslc verify --engine induction "$spec" | jq -e '.result == "proved"' > /dev/null || {
        fslc verify --engine induction "$spec" || true
        echo "::error file=$spec::the invariants hold only up to a bounded depth"
        exit 1
      }
      ;;
    *)
      fslc verify --engine auto --deadlock error --depth 32 "$spec" || true
      echo "::error file=$spec::fslc verify returned $result"
      exit 1
      ;;
  esac
  echo "::endgroup::"
done

for mapping in ${refinements[@]+"${refinements[@]}"}; do
  echo "::group::$mapping"
  line=$(sed -n -E 's|^// refine: ([^ ]+) ([^ ]+)$|\1 \2|p' "$mapping")
  impl=${line%% *}
  abs=${line#* }
  if [ -z "$line" ] || [ -z "$impl" ] || [ -z "$abs" ]; then
    echo "::error file=$mapping::missing the line // refine: <impl>.fsl <abs>.fsl"
    exit 1
  fi
  (cd specs && fslc refine --depth 8 "$impl" "$abs" "$(basename "$mapping")") | jq -e '.result == "refines"' > /dev/null || {
    (cd specs && fslc refine --depth 8 "$impl" "$abs" "$(basename "$mapping")") || true
    echo "::error file=$mapping::fslc refine did not return refines"
    exit 1
  }
  echo "::endgroup::"
done
