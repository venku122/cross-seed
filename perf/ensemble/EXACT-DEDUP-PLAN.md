# Exact ensemble membership suppression

Goal: suppress repeat observations of the same five-field ensemble membership
before filesystem I/O, retaining distinct aliases and recorded hosts/hashes in
insertion order. This changes lookup work only; stored duplicate rows remain.

Base: PR1 `17a779988c496d2bc0729467856ea7dfcaf37833`.

- [x] Draft regression tests in `cross-seed/tests/ensembleLookup.test.ts`
      against migrated SQLite and public `checkNewCandidateMatch`, retaining
      real filesystem operations and mocking only the external assessment
      boundary.
- [x] After timing lock release, observe RED for repeated access calls, then
      implement the smallest correct suppression in
      `cross-seed/src/pipeline.ts`.
- [x] Run focused GREEN, format, build, lint, typecheck and complete test suite.
- [x] Freeze source; obtain independent review before measured runs.
- [x] Explore JavaScript JSON tuple suppression versus SQL full-tuple GROUP BY
      ordered by MIN(rowid) in compiled pipeline workers. Record transformation
      checksums; these pilots do not constitute final candidate measurements.
- [x] Select implementation using measured no-duplicate and duplicate-heavy
      costs.
- [x] Run unmodified compiled base/head/base, five fresh-worker rounds per case,
      with exact source hashes and raw results outside the repository.

Correctness tests cover exact repeats, per-lookup reset, full tuple fields,
alternate title aliases, different info hashes, NULL versus empty client host,
delimiter values, distinct episode elements, first physical source order and
existing path-wide missing-file cleanup.

Filesystem observations are not atomic: a file appearing, disappearing or
changing between repeat memberships will no longer be observed repeatedly for
that exact tuple in the same lookup. Distinct memberships still observe
independently; subsequent lookups recheck. No persistent filesystem cache is
introduced.

Benchmark labels:

- Full matching 1M memberships: 1/2/5 aliases, repeat 1 or 10, constant
  filesystem instrumentation. These measure pipeline/SQLite cost and production
  access/stat invocation counts, not actual filesystem latency.
- Real filesystem: 1M total rows, 20 matching memberships, 10 repeats, 1/2/5
  aliases, 0/5/50ms synthetic delay per access/stat invocation. The small
  selected cardinality bounds execution time; the delays are not measurements of
  NFS or ZFS.
- Digests cover actual query full tuples (distinct, ordered) and assessed output
  files. Two physical source paths ensure first-source selection remains
  observable.
- RSS and CPU are synthetic workload measurements; loopback ping runs the actual
  compiled Fastify baseApiPlugin /api/ping route and measures process
  responsiveness.

Command after both checkouts are compiled with Node 26:

```sh
node --experimental-test-module-mocks perf/ensemble/exact-dedup-benchmark.mjs BASE_CHECKOUT EXTERNAL_OUTPUT
node --experimental-test-module-mocks perf/ensemble/exact-dedup-benchmark.mjs BASE_CHECKOUT EXTERNAL_OUTPUT --final-head HEAD_CHECKOUT
```

No commit, push, production access or upstream publication is authorized in this
worker. The root agent coordinates review, publication and local timing
ownership.
