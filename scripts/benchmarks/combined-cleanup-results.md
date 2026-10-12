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

No harness fixtures or comparative timings have run yet. Combined acceptance,
independent review, final frozen source identity and all measurements are
pending. No combined branch publication or deployment is authorized.

The tiny platform runner executes four correctness workers (baseline/candidate,
one/five memberships). Synthetic roots and file-URL arguments use native path
separators so the harness can run under pinned Node 26 on macOS, Linux or
Windows. No Linux or Windows execution is claimed until an actual platform
result exists.

```sh
node scripts/benchmarks/combined-cleanup-platform-smoke.mjs /absolute/prior-combined-baseline /absolute/integration /absolute/external-platform-results
```
