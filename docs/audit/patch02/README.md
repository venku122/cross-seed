# Cleanup validation

This branch starts at `8a0c428edb9f8439e5138261047d2d0e3b3a4b78`. The prepared
patch was reworked to merge indexed `data`/`ensemble` path streams, check 512
distinct paths per page with at most 64 concurrent filesystem accesses, and
delete corresponding records in one SQLite transaction per batch.

Keyset conditions apply to both UNION branches, enabling SQLite to merge their
path indexes without repeatedly sorting the whole remaining population. Nullable
paths are retained. Multiple ensemble memberships are preserved for existing or
uncertain paths. A path shared by both scanned tables is checked once.

Cleanup previously interpreted every filesystem access error as a missing file.
This change only deletes after `ENOENT` or `ENOTDIR`. Other failures retain
cached records. Configured data roots are checked once per page only when
missing paths would be deleted, with at most 64 concurrent root checks. A root
access failure stops filesystem pruning and retains the current page;
snatch-history and torrent-cache housekeeping continue. All configured roots
guard pruning conservatively because ensemble paths may come from torrent
directories or clients and do not necessarily map uniquely to a configured data
root. This also defers unrelated accessible roots' deletions for that cleanup
run. Existing entries require no root probes.

A mounted root that still exists but silently exposes an empty directory cannot
be detected by access alone. Universal mount identity checks are not portable
across the supported operating systems and are outside this patch. The page
guard is a safety heuristic, not an atomic filesystem/database operation: a root
can become unavailable after the guard, and paths can reappear after access but
before deletion, as in the baseline. Operators should disable filesystem pruning
during known mount outages that leave an accessible empty directory.

Watcher changes between pages are tolerated: deletions do not shift a keyset;
new paths after the cursor can be scanned; paths inserted behind a captured
cursor are deferred to the next cleanup. Files can still change between an
existence check and deletion, as in the baseline. Each pair of table deletions
rolls back together if either deletion fails, and a subsequent cleanup can
restart.

## Reproduce

Use Node >=26 and install the pinned lockfile with `npm ci`. Build both clean
baseline and candidate worktrees with `npm run build`. The benchmark worker
imports each worktree's compiled `db.js`, migrates an isolated in-memory
database, and starts the production `serve()` HTTP server on loopback. A
separate process records real HTTP `/api/ping` requests during cleanup, so a
blocked daemon event loop is visible in request latency. Private trackers and
real torrent clients are not used; the optional refresh mode uses fake client
responses through production ensemble rebuilding. Synthetic cached paths use
mocked `fs/promises.access` delays of 0/5/50 ms. These are **not real NFS
measurements**.

```sh
CI=1 npm -w cross-seed test -- --run tests/cleanup.test.ts
node docs/audit/patch02/run-cleanup.mjs BASELINE_WORKTREE CANDIDATE_WORKTREE \
    /external/path/cleanup-results.json 5
```

The runner executes five fresh-process A/B/A rounds per scenario and preserves
every operation, memory, CPU, event-loop, SQL/query-plan, filesystem count and
HTTP sample. Small and delayed scenarios contain twenty cleanup operations per
process. Large scenarios contain 200k/1M ensemble rows (five memberships per
path) and one cleanup per process. Every worker verifies retained row counts,
HTTP responses, and SQLite integrity. Git SHA plus source/compiled module hashes
identify the code actually loaded. No absolute checkout/config paths are saved.

Large correctness regressions also invoke actual cleanup against migrated
in-memory SQLite, deleting every seventeenth path and validating all surviving
memberships. Focused tests cover empty/one/100 rows, multiple pages, duplicates,
null/unusual paths, watcher insertions/deletions/moves, unavailable roots,
transient permission/mount errors, transaction rollback and restart.

## Validation status

Initial baseline focused regression run: 9 expected failures, 5 passes. The
bounded-concurrency regression observed 5,500 active access requests, exceeding
the limit of 64. Other failures exposed deletion after uncertain filesystem
errors, missing-root deletion, null-path probes, cursor semantics and partial
cross-table deletion after an error.

First candidate focused run: 14/14 passed. Final regression set: 21 cleanup
tests passed, including 200k/1M-row fixtures. Node26 full workspace checks
passed: `npm run format:check`, `npm run build`, `npm run lint`,
`npm run typecheck`, `CI=1 npm run test` (85 tests: 81 backend, 3 shared, 1
webui). The identical lockfile dependency installation was validated with a full
`npm ci` in the baseline worktree and shared through local workspace dependency
links.

Actual compiled worker smoke passed with the production HTTP server, a 200/OK
`/api/ping` response, correct retained rows and SQLite integrity. Query plans
reported `MERGE (UNION)` and `SEARCH` using both covering path indexes. The
first complete 105-worker A/B/A matrix is retained as
`cleanup-initial-negative-results.json`. It exposed a roughly 1 ms timer tax on
small fixtures from the existing yield helper. An added regression observed an
artificial zero-duration timer scheduled during one-path cleanup. The helper now
yields with `timers/promises.setImmediate` between full pages and returns after
the final short page. Timer regression, final full gates and a second complete
paired matrix validate the revised scheduling. Final timing results are recorded
below. Isolated npm package installation and Node26 CLI `--version` smoke passed
using controller-managed staging; shared workspace dependency links were
preserved.

## Original paired measurements (before review followup)

Node 26.11.1, Apple M1 Pro, macOS arm64, SQLite 3.53.4. Five A/B/A rounds per
scenario produced ten baseline and five candidate processes. The large fixtures
have one cold operation per fresh process; small and delayed fixtures have
twenty operations. Large measurements do not include twenty warm repeats. Pooled
operation/HTTP p95 and p99 are descriptive, without confidence intervals. HTTP
p99 at large sizes has only 22 baseline and 185 candidate request samples.

Both tables are populated: 200k ensemble rows means 40k distinct paths plus 40k
data rows; 1M ensemble rows means 200k distinct paths plus 200k data rows. Each
path has five alternate ensemble memberships. All benchmark paths remain
accessible; deletion correctness is covered by separate regression fixtures. The
benchmark does not measure transaction/delete overhead or large delayed
filesystem populations.

| Fixture       | Wall p50 ms, baseline / candidate | CPU ms           | Peak process RSS MiB | HTTP ping p95 / p99 ms        |
| ------------- | --------------------------------- | ---------------- | -------------------- | ----------------------------- |
| 200k ensemble | 164.04 / 54.17                    | 218.46 / 66.35   | 320.95 / 188.19      | 178.72 / 182.42 → 2.10 / 3.40 |
| 1M ensemble   | 853.45 / 228.47                   | 1082.57 / 252.34 | 844.43 / 397.48      | 872.99 / 981.55 → 1.52 / 4.04 |

RSS includes runtime startup, migrated in-memory SQLite and fixture storage. At
1M ensemble rows the median peak heap falls from 373.44 to 53.55 MiB; event-loop
p99 falls from 857.47 to 6.35 ms. Filesystem access calls fall from 1,200,000 to
200,000, while SQL calls rise from 5 to 394 and 391 immediate root guards are
added. At 200k ensemble rows SQL calls rise from 5 to 82. Missing-path batches
additionally use a transaction and recheck every configured root. The actual
generated candidate query plan uses `MERGE (UNION)` with covering path-index
`SEARCH` operations. Baseline before/after wall drift is 0.39% at 200k ensemble
and 0.63% at 1M.

| Distinct paths / access delay | Wall p50 ms, baseline / candidate | Wall p95 ms       |
| ----------------------------- | --------------------------------- | ----------------- |
| 0 / 0 ms                      | 0.504 / 0.495                     | 1.708 / 1.050     |
| 1 / 0 ms                      | 0.550 / 0.560                     | 1.391 / 1.879     |
| 100 / 0 ms                    | 1.039 / 0.805                     | 3.068 / 2.526     |
| 100 / 5 ms                    | 12.189 / 11.668                   | 17.881 / 14.211   |
| 100 / 50 ms                   | 102.649 / 102.161                 | 105.993 / 105.333 |

Small-case median changes range from -22.5% to +1.9%. The one-path pooled p95
increases by 0.489 ms (+35.1%), and median cold time rises from 1.962 to 2.180
ms; these small absolute costs are disclosed, not described as no regression.
The stronger uncertainty/root safety checks remain enabled. At 50 ms mock delay,
CPU increases from 11.076 to 11.654 ms per operation (+5.2%), HTTP ping p95 from
1.968 to 2.396 ms and p99 from 4.436 to 4.929 ms. Those submillisecond HTTP
tails are noisy; this delayed fixture does not demonstrate an API improvement.
Concurrency on delayed fixtures is 500 baseline versus 64 candidate, with six
cached-path accesses reduced to one per unique path. The concurrency limit can
increase total cleanup time on large delayed populations; that tradeoff is not
measured here and real NFS performance is not established.

The first negative matrix remains available to show the rejected scheduling
behavior. The corrected source is identified by SHA256
`78e7e56e6db3801ec3ad0be3ae089e578edfe1bad8c4e014a5cbcb2ebd785c28`; the compiled
module is `a6f07370435658fa512440f8cd6f35a7772934c8f901cfd182bb999589fed923`.
Both baseline and candidate were measured before the candidate commit, so raw
`gitSha` records the observed baseline HEAD; source/compiled hashes distinguish
the actual implementations. The review commit retains exactly that candidate
source. The controller pins its final commit SHA in the review handoff.

Raw evidence: `cleanup-results.json`; complete initial-negative evidence:
`cleanup-initial-negative-results.json`; reproducible aggregation:
`node docs/audit/patch02/summarize-cleanup.mjs`. Summary metrics are in
`cleanup-summary.json`. Related incident:
[#1074](https://github.com/cross-seed/cross-seed/issues/1074).

Lockfile SHA256:
`88da27532b3b03440bbae2726942de02d7cff581b83be9374410e2426a5b285d`.

## Review followup

The review revision isolates root failures from later housekeeping, removes root
probes on pages with no missing paths, and reduces destructive-page root probes
from one per batch plus one per page to one per page. Paired table deletes still
use transactions of at most 64 paths; filesystem checks remain bounded to 64 and
only `ENOENT`/`ENOTDIR` authorize a deletion candidate. Regression coverage adds
root-failure housekeeping, conservative two-root preservation, and root call
counts for three-page accessible/missing fixtures. The existing measurements
above identify the previous implementation and must not be attributed to this
revision.

Review followup verification on Node 26.11.1 passed all workspace gates:
`format:check`, `build`, `lint`, `typecheck`, and 90 tests (86 backend including
26 cleanup tests, three shared, one webui). Five expected regression failures
were observed before the source fix. Compiled smokes passed refresh/upsert,
destructive-page pruning, and real metadata access to disposable local files;
the real-access JSON was checked for private fixture-path leakage. These smokes
verify harness behavior and do not establish real NFS performance.

The `followup` runner profile adds 40k/200k distinct paths with five memberships
and 5 ms mock access delay, a 40k-path missing-every-seventeenth fixture with 5
ms mock root delay, plus end-to-end cleanup with fake client refresh at
100/40k/200k paths. Refresh begins with no ensemble rows, returns complete
episode searchees from five fake clients, uses real `cacheEnsembleTorrentEntry`
rebuilding and verifies the resulting row counts. This measures the combined
refresh, ensemble rebuild and filesystem cleanup rather than claiming bounded
total refresh memory. The worker accepts optional `MODE=cleanup|refresh` and
mock root delay arguments and an optional missing-every-N argument after its
operation count. Accessible-only benchmark populations need no root guards; the
destructive fixture additionally validates paired retained row counts and SQLite
integrity.

```sh
node docs/audit/patch02/run-cleanup.mjs BASELINE_WORKTREE CANDIDATE_WORKTREE \
    /absolute/controller/results/review-followup/cleanup/results.json 5 followup
# Small refresh smoke, using the already compiled candidate:
node docs/audit/patch02/cleanup-worker.mjs CANDIDATE_WORKTREE 100 5 0 1 refresh 0
```

Keep fresh raw results outside tracked audit files under the controller's
`results/review-followup/cleanup/` directory. Use their source/compiled SHA256
identities when reporting fresh metrics. Mock delayed I/O is not a real NFS
measurement; concurrency limits can lengthen total cleanup time while reducing
outstanding operations. Refresh still materializes client searchees and ensemble
rows before insertion, so its memory cost may dominate end-to-end results.

For controller-run real metadata access, the worker accepts
`real FIXTURE_ROOT PRIVATE_PATH_LIST.json` after `mode rootDelay missingEvery`.
The private list must contain exactly COUNT distinct absolute paths under the
mounted root. Use zero mock delays and zero missing fraction. Only `access`
reads those paths; database, logs, config and server remain disposable.
Query-plan bindings are explained before path redaction, and no private paths
are emitted in result JSON. Real mode fails if retained row counts differ, so
fixture changes cannot pass as a timing sample. Optional `BENCH_GIT_SHA`
identifies container checkouts without Git.

```sh
node docs/audit/patch02/cleanup-worker.mjs CHECKOUT COUNT 5 0 1 refresh 0 0 \
    real READ_ONLY_FIXTURE_ROOT PRIVATE_PATH_LIST.json
```

### Fresh paired followup measurements

Node 26.11.1, Apple M1 Pro, macOS arm64, SQLite 3.53.4; five fresh-process A/B/A
rounds per scenario (90 workers). Every worker passed retained/deleted row
counts, SQLite integrity and HTTP response checks. Values below are baseline /
review revision; RSS includes fixtures and runtime. Wall values are medians of
process medians. HTTP tails pool samples and are descriptive, without confidence
intervals.

| Fixture                                        | Wall ms            | Peak RSS MiB      | HTTP ping p95 / p99 ms                |
| ---------------------------------------------- | ------------------ | ----------------- | ------------------------------------- |
| 40k paths, every 17th missing, 5 ms root delay | 229.03 / 561.33    | 317.10 / 189.97   | 1198.28 / 1198.28 → 2.07 / 3.17       |
| 40k paths, 5 ms access delay                   | 371.70 / 3889.57   | 330.90 / 189.95   | 32.26 / 101.73 → 3.83 / 9.78          |
| 200k paths, 5 ms access delay                  | 1944.42 / 19535.24 | 836.77 / 399.84   | 10.79 / 132.20 → 3.83 / 7.35          |
| Refresh 100 paths, 20 operations               | 4.68 / 4.48        | 147.62 / 145.36   | 12.24 / 14.44 → 10.13 / 10.80         |
| Refresh 40k paths, one cold operation          | 1542.50 / 1422.84  | 575.99 / 484.33   | 2088.00 / 4614.51 → 1372.68 / 1506.84 |
| Refresh 200k paths, one cold operation         | 10442.41 / 9912.26 | 1879.80 / 1431.98 | 15634.74 / 15634.74 → 2.18 / 9895.35  |

Five memberships per path are present in every scenario. Delayed access
concurrency falls from 10,000 to 64, and calls fall from six per path to one.
The 64-request limit increases total delayed cleanup time by roughly ten times
while reducing outstanding I/O, memory and HTTP tails. The destructive fixture
adds 79 root guards at 5 ms each; its longer wall time is a disclosed safety
cost. Accessible-only and refresh fixtures require zero root guards. Regression
tests separately show guard counts falling from 21 to three for a fully missing
1,100-path fixture versus the earlier review implementation.

Large refresh still materializes five clients' searchees and ensemble rows; its
approximately ten-second cold wall time and high RSS show that filesystem
cleanup improvements do not proportionally improve the complete job. The 200k
refresh candidate's low pooled HTTP p95 hides an initial stall visible in its
9.9-second p99. Baseline/candidate HTTP sample counts are only 18/169 for that
fixture, 20/44 for 40k refresh, and 19/412 for the destructive fixture, so those
tails are especially sparse. Baseline before/after median wall drift is +6.31%
for destructive pruning, -1.73%/-3.15% for delayed 40k/200k, and
+0.47%/+0.98%/-1.18% for refresh 100/40k/200k. Individual refresh runs vary with
runtime/GC behavior. These are synthetic local measurements, not real NFS.

Fresh source SHA256:
`958163f9f0678ad824d229ff29570fc5eedef2746ff34d79325811fcc854c88b`; compiled
module: `a3035a8d2363a163f76e51e7d9d0475be6a1e1f5d382ea173d5e7470e319f956`.
Controller-held raw and summary evidence remains outside Git at
`results/review-followup/cleanup/followup-results.json` and
`followup-summary.json`; the complete runner log is `followup-run.log`.

## Native TrueNAS ZFS follow-up

An isolated Linux amd64 instrumented container ran beside production as UID/GID
1000, with no network, read-only media/config mounts, a private results volume,
and disposable migrated in-memory SQLite. Production was not restarted or
modified. Actual `access()` calls used 14,201 existing paths from a consistent
read-only cache snapshot; media mount filesystem was verified as ZFS. The
metadata was warm. No cold-cache, NFS transport, disk content throughput, real
client RPC or production database deletion is measured.

Five A/B/A rounds per size/mode produced 90 workers; all retained counts, SQLite
integrity and HTTP response checks passed. Each path had five synthetic ensemble
memberships. Refresh uses five fake clients through production rebuilding.

| Paths / mode           | A1 / candidate / A2 wall ms | A1 / candidate / A2 peak RSS MiB |
| ---------------------- | --------------------------- | -------------------------------- |
| 1,000 prune            | 35.69 / 8.86 / 35.34        | 122.9 / 107.3 / 122.6            |
| 10,000 prune           | 598.12 / 97.80 / 601.69     | 246.4 / 135.7 / 246.8            |
| 14,201 prune           | 846.38 / 134.36 / 875.08    | 257.2 / 155.0 / 258.5            |
| 1,000 refresh + prune  | 133.76 / 100.96 / 123.29    | 182.5 / 143.6 / 182.4            |
| 10,000 refresh + prune | 1609.93 / 1066.50 / 1602.81 | 315.6 / 245.8 / 316.1            |
| 14,201 refresh + prune | 2255.85 / 1505.80 / 2291.04 | 376.7 / 308.6 / 377.5            |

Real ZFS metadata improved despite the roughly tenfold delayed-timer regression.
Timer mocks allow thousands of instantly scheduled requests and do not model
actual filesystem queues. Neither result establishes performance on every NAS.
Production health monitoring recorded 190 successful pings, unchanged start time
and zero restarts. The separate job completed cleanup then exited because its
assessment metadata loader lacked a lockfile; the valid 90 cleanup worker
results are retained. Assessment runs were restarted separately with complete
provenance.

## External artifacts and clean CI

Raw JSON, negative matrices, and the former duplicated Docker evidence are
preserved in the
[checksummed benchmark archive](https://github.com/venku122/cross-seed/releases/tag/benchmark-evidence-2026-10-11),
with specific assets and hashes linked from the PR description. Run harnesses
with external output paths; raw samples are excluded from source history. Fresh
fork Linux Node26 and Windows tarball CI runs without a precreated `CONFIG_DIR`.
Local macOS acceptance uses an isolated precreated directory; Docker publication
is guarded to upstream.
