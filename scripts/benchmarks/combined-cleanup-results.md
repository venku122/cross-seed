# Local combined cleanup validation

The prior matching/index/cleanup combination is local commit
`3cf38d21982b6d816d2c9977e5a4c567d23b0a30`, based on matching
`b7b6973f24dcf3d699b46454b4b29b76b5a8583f` and cherry-picked index
`17a779988c496d2bc0729467856ea7dfcaf37833` and cleanup
`d330de4986c562406c71613e1f3a8953e8d5ccb6`. This is the comparison baseline
before targeted refresh, health, batching, streaming, and later dedup selection.

The new harness measures actual compiled `cleanupDB`, the actual qB adapter's
full refresh, SQLite cache lookup and full JSON writes, title/ensemble
generation, optional candidate staging, filesystem pruning, and housekeeping. A
source-shaped fetch transport returns embedded qB 5.1 files and trackers; no
live client URL is accepted. The raw synthetic catalog is constructed before
measurement. Its JSON encoding, response text decoding/parsing, adapter file
conversion, full refresh arrays and cache writes run within the measured
cleanup. A real production `serve()` listener handles loopback `/api/ping`,
measured by a separate process.

Four fixtures cross 8,194/30,000 torrents with one/five title aliases and 50
files per torrent. The five generated memberships are four AKA fragments plus
the combined title retained by the existing parser. Each runs five fresh A/B/A
rounds (60 workers). Warm cache population uses the actual adapter outside
measurement. Source metadata/file arrays remain materialized, including one
parsed full catalog and searchee arrays; staging only bounds generated ensemble
rows. The named client host means multiple aliases conflict on the same path;
the baseline last-alias winner must match candidate rows and row order.
Migrations and Node's SQLite adapter are actual; the disposable database is in
memory. Filesystem `access` is synthetic, with one obsolete path rejected as
ENOENT; housekeeping parses/deletes one valid expired torrent fixture and
removes its old decision row. This is synthetic shape evidence, not live
workload weights, NFS, network timing, or cold disk.

Each worker records source/dist/lock/harness hashes, Node/SQLite/hardware,
request and response body bytes, cache JSON bytes actually read, string insert
binding bytes, SQL calls/durations and reader delays, API ping distributions,
event-loop p95/p99/max, ELU, CPU, sampled peak RSS/heap, and process peak RSS.
Binding bytes are string payload size, not a SQLite wire protocol. Sampled peaks
can miss a synchronous burst; process peak includes setup. Output/cache/data
digests, expected row counts, generated source/alias counts, integrity and
housekeeping outcomes are checked before samples are accepted. Raw logs are
retained even on nonzero exit or memory failure. No silent smaller fixture
substitution occurs.

Build both exact isolated checkouts first, with pinned shared dependencies. Only
run in a parent-granted exclusive timing slot:

```sh
node scripts/benchmarks/combined-cleanup-aba.mjs /absolute/prior-combined-baseline /absolute/integration /absolute/external-results
```

The worker also accepts a small source count for structural smoke (aliases must
be one or five):

```sh
BENCH_FILES=50 node scripts/benchmarks/combined-cleanup.mjs /absolute/integration 3 5 0 1 refresh
```

## Completed acceptance

All five source gates and 184 workspace tests passed. All four original
Dockerfile builds passed for candidate/prior-three ×arm64/amd64, pinned to
Node26. Both compiled runtime smokes and eight tiny Linux A/B workers passed
cache/data/membership digests, migrations, rollback, health/scoped-qB behavior,
hardlinks, API ping and served assets. amd64 ran under emulation; these are
correctness checks. Initial CLI read-only-config failures and harness setup
failures remain preserved alongside successful corrected runs.

The final native matrix completed all 60 workers: four fixtures ×five fresh
A/B/A rounds. Full stored/output hashes and operation counts match; no final
worker failed. Production source is local commit
`12464ec1fcb74bd913336f46b5879037d2ea0963`; harness-only commit
`0f03b96724c4bfb85d686db70766fbcac00fe545` adds controller timeouts and
original/executed generator hashes. Application source is unchanged. The
counting hook transforms only the actual compiled generator return site; both
original and executed module hashes are recorded in every final worker.

The table reports median per-worker metrics, not population tail estimates. Five
head values make across-worker p95/p99 maxima; pooled HTTP distributions,
individual observation counts and A1/A2 drift remain external.

| Torrents | Aliases | Base/head wall ms | Base/head CPU ms  | Base/head process peak RSS MiB | Base/head sampled peak RSS MiB | Base/head ping p99 ms |
| -------: | ------: | ----------------- | ----------------- | ------------------------------ | ------------------------------ | --------------------- |
|    8,194 |       1 | 649.59 / 404.88   | 868.26 / 566.96   | 649.79 / 606.50                | 627.79 / 584.11                | 633.36 / 151.17       |
|    8,194 |       5 | 856.84 / 615.00   | 1133.28 / 802.60  | 655.30 / 612.00                | 636.44 / 590.73                | 842.27 / 147.10       |
|   30,000 |       1 | 2324.62 / 1446.90 | 3438.17 / 2344.05 | 2109.31 / 1983.56              | 1390.66 / 1874.06              | 2288.63 / 539.65      |
|   30,000 |       5 | 3034.06 / 2227.85 | 4189.16 / 3125.51 | 2128.93 / 2009.95              | 1398.82 / 1897.88              | 2999.56 / 398.64      |

Wall improves 26.6–37.8% and CPU 25.4–34.7%. SQL calls fall from 8,389→169 and
8,717→265 at 8,194 torrents; 30,677→568 and 31,877→924 at 30k. Forced refresh
reads zero cached file-JSON bytes versus 25.7/94.3MB baseline; full cache file
JSON writes and final cache digests remain equivalent.

**Whole-job memory is still large.** At 30k, sampled peak RSS rises 34.8–35.7%,
from about 1,391MiB to 1,874–1,898MiB. Process peak (including fixture setup)
falls only about 6%, from 2,109–2,129MiB to 1,984–2,010MiB. The baseline
synchronous burst can evade the interval sampler, while candidate yields expose
samples; these measures are not interchangeable or evidence of an equivalent
whole-job memory reduction. Full catalog/file/searchee arrays remain
materialized.

30k/five aliases still has median HTTP maximum 545ms and loop maximum 546ms; its
ping p99 median is399ms. JSON transport decoding and full refresh remain
synchronous hotspots despite the improvements. There is no actual production
traffic weighting, cold-disk test, live torrent client or new NFS/ZFS claim.
Individual batching, streaming and dedup drafts retain their negative cases;
combined gains do not override those separate acceptance gates.

[Immutable combined evidence and checksums](https://github.com/venku122/cross-seed/releases/tag/benchmark-next-audit-2026-10-12):
`combined-cleanup-platform-node26-evidence.zip`. The optional local validation
Git bundle preserves the exact combined source/harness without a combined PR.
Raw results and private offline database data stay outside source diffs.

The tiny platform runner executes four correctness workers (baseline/candidate,
one/five memberships). Synthetic roots and file-URL arguments use native path
separators so the harness can run under pinned Node 26 on macOS, Linux or
Windows. Linux arm64 and emulated amd64 results are recorded above; no native
Windows execution of this combined harness is claimed. Independent fork PR
Windows package CI is recorded separately.

```sh
node scripts/benchmarks/combined-cleanup-platform-smoke.mjs /absolute/prior-combined-baseline /absolute/integration /absolute/external-platform-results
```
