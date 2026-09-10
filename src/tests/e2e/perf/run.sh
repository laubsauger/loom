#!/usr/bin/env bash
# The §V713-clean profiling run (T1235): the tree as committed, in its own directory, on
# its own dev server, with only this harness copied on top — so a half-edited working
# copy in another session cannot hot-reload into the numbers.
#
#   src/tests/e2e/perf/run.sh [out dir]           # all fixtures
#   PERF_FIXTURES=E24,E55 src/tests/e2e/perf/run.sh
#   PERF_REF=HEAD~1 src/tests/e2e/perf/run.sh      # a before/after pair: the same harness,
#                                                  # the same machine, one ref then the other (T1182)
#
# Results land in the out dir (default scratchpad/perf/<timestamp> under the REAL tree,
# which is gitignored), then `summarize.ts` prints the markdown tables from them.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
out="${1:-$root/scratchpad/perf/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$out"
work="$(mktemp -d "${TMPDIR:-/tmp}/loom-perf.XXXXXX")"
ref="${PERF_REF:-HEAD}"
echo "archive $ref ($(git -C "$root" rev-parse --short "$ref")) -> $work"
git -C "$root" archive "$ref" | tar -x -C "$work"
mkdir -p "$work/src/tests/e2e/perf" "$work/src/tests/perf"
cp -R "$root/src/tests/e2e/perf/." "$work/src/tests/e2e/perf/"
cp -R "$root/src/tests/perf/." "$work/src/tests/perf/"
ln -s "$root/node_modules" "$work/node_modules"
echo "machine load before the run (anything above 20% CPU that is not this run is noise to report):"
load="$(ps -Ao pid,%cpu,command -r)"; printf '%s\n' "$load" | sed -n '1,6p' | cut -c1-110
git -C "$root" rev-parse "$ref" > "$out/commit.txt"
(cd "$work" && PERF_OUT_DIR="$out" pnpm exec playwright test -c src/tests/e2e/perf/playwright.config.ts)
node --import "$root/src/tooling/alias-hooks.ts" "$root/src/tests/e2e/perf/summarize.ts" "$out" > "$out/summary.md"
echo "summary: $out/summary.md"
rm -rf "$work"
