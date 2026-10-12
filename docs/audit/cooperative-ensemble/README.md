# Cooperative ensemble rebuilding

Baseline is the completed cleanup paging PR2, commit
`d330de4986c562406c71613e1f3a8953e8d5ccb6`. Pruning pagination, root guards and
housekeeping retain that implementation. This change replaces the all-source
membership flatMap in cleanup and torrent indexing.

Generation runs in ordered groups of at most 64 sources. All reads in a group
settle before an error propagates. A 500-row buffer writes to a temporary SQLite
staging table, with real setImmediate yields after a flush or 256 sources. The
ordered atomic INSERT SELECT then applies the original client_host/path conflict
behavior. NULL-host aliases and exact repeats remain stored; named-host aliases
retain the original last-winner behavior. This performance patch does not repair
ensemble identity.

The initial transaction-across-generation prototype let timers run but reserved
SQLite's sole connection. It was replaced before comparative acceptance: staging
releases the connection during generation, and tests prove another DB reader can
progress. The final atomic apply is still synchronous main-thread SQLite and can
block SQL-backed endpoints and timers. TEMP staging depends on the existing
single-entry SQLite pool and requires temporary storage. Memory is bounded for
intermediate production rows, not the whole job: client/file arrays remain, plus
up to 64 complete generated source-entry arrays and the 500-row buffer. A single
source can still generate a large array or synchronously scan many files.

## Correctness

Node 26.11.1 full source gates and 100 workspace tests pass. Ten new regressions
exercise early staging, timers and concurrent DB reads, ordered NULL aliases and
repeats, existing named-host row order, bounded out-of-order generation, actual
startup indexing, empty catalogs, generation failure and late SQL trigger
rollback. Failed staging/apply leaves live memberships intact and drops TEMP
state. Client-cache refresh before the membership writer remains outside this
atomic apply. A known saved-torrent assertion race was also observed and
retained; it reproduced on pristine upstream in one of five runs. The final
suite passed.

## Reproduction

Build pristine PR2 and this tree with the same lockfile and Node 26. Run alone:

```sh
node scripts/benchmarks/ensemble-streaming-aba.mjs BASELINE HEAD EXTERNAL_RESULTS
```

The matrix uses 0/1/100/8,194/20,000/30,000 sources and 1/2/5 parsed title
aliases, plus 100 sources with 1,000 files, one with 10,000 files, delayed
filesystem checks and delayed download-directory lookups. It invokes compiled
cleanupDB and the public startup indexing wrapper, the actual membership
generator, migrated SQLite and production serve()/api/ping. Each fixture runs
five fresh A/B/A process rounds. Ordered membership digests must match and
source/compiled identities remain pinned throughout. A concurrent SQLite count
probe measures DB-reader latency; its SQL/CPU is included and disclosed rather
than presented as an actual application endpoint. Final apply and maximum
statement durations are recorded separately.

These rebuild fixtures supply already-materialized searchees through fake
clients; they do not measure real-adapter catalog decoding/cache serialization.
The separate four-adapter cache matrix and combined actual-qB cleanup benchmark
address those boundaries. Access delays are timer mocks, not NFS/ZFS
measurements. Ping p99 is read with sparse sample counts. Sampled RSS/heap can
miss short bursts; process maximum RSS includes fixture setup but excludes
post-measurement digest checking.

Raw, negative and intermediate failure evidence remains external. The bounded
concurrency case caught a callback argument leak into the generator's optional
save-path-map parameter; a source-only callback and regression fixed it before
publication. No production client or filesystem was accessed.

## Measured acceptance

Final five-round distributions and negative results will be added after the
exclusive timing window. No throughput, whole-job memory or universal latency
claim is made from the structural tests.
