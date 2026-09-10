#!/usr/bin/env bash
# The §V713-clean profiling run (T1235): the tree as committed, in its own directory, on
# its own dev server, with only this harness copied on top — so a half-edited working
# copy in another session cannot hot-reload into the numbers.
#
#   src/tests/e2e/perf/run.sh [out dir]           # all fixtures
#   PERF_FIXTURES=E24,E55 src/tests/e2e/perf/run.sh
#   PERF_REF=HEAD~1 src/tests/e2e/perf/run.sh      # a before/after pair: the same harness,
#                                                  # the same machine, one ref then the other (T1182)
#   PERF_KEEP_TRACES=1 src/tests/e2e/perf/run.sh   # ALSO keep the raw CDP traces (T1277) —
#                                                  # 27–110 MB per scenario, for a flame chart
#                                                  # in DevTools; nothing here reads them back
#
# Results land in the out dir (default scratchpad/perf/<timestamp> under the REAL tree,
# which is gitignored), then `summarize.ts` prints the markdown tables from them.
#
# T1277/§B206: this prunes old raw traces on every invocation (`prune-traces.ts` — it can
# only ever delete a `*.trace.json`, never a `summary.md` or a `<fixture>.json`, because
# SPEC rows cite those by path), and §B204: it exits NON-ZERO when an arm did not run, so
# a partial set cannot be read as a complete one.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
out="${1:-$root/scratchpad/perf/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$out"
node --import "$root/src/tooling/alias-hooks.ts" "$root/src/tests/e2e/perf/prune-traces.ts" \
  "$root/scratchpad/perf" --keep 3 --protect "$(basename "$out")"
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
# §B204 — a failed arm must NOT skip the summary: the arms that did run are still worth
# reading, and the summary is where the hole has to be visible. So the status is captured
# rather than allowed to abort the script, handed to `summarize.ts`, and re-raised at the
# end — a partial run leaves a marked artefact AND a non-zero exit.
status=0
(cd "$work" && PERF_OUT_DIR="$out" pnpm exec playwright test -c src/tests/e2e/perf/playwright.config.ts) || status=$?
printf 'playwright-exit=%s\n' "$status" > "$out/run-status.txt"
summary=0
node --import "$root/src/tooling/alias-hooks.ts" "$root/src/tests/e2e/perf/summarize.ts" "$out" > "$out/summary.md" || summary=$?
echo "summary: $out/summary.md"
rm -rf "$work"
if [ "$status" -ne 0 ] || [ "$summary" -ne 0 ]; then
  echo "INCOMPLETE RUN (playwright exit $status, summarize exit $summary): an arm did not run — the summary is marked and these numbers are not a full set (§B204)." >&2
  exit 1
fi
