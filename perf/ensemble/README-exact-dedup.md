# Exact membership lookup experiment

The proposal suppresses filesystem work for exact repeated
`(client_host,path,info_hash,ensemble,element)` memberships before
episode-source selection. It retains legitimate aliases and distinct recorded
hosts/hashes, and preserves the first physical source in SQLite rowid order.
This is an interim lookup improvement; it does not remove stored duplicates or
repair ensemble identity.

The baseline includes the ensemble lookup index and source-order fix from PR1,
commit `17a779988c496d2bc0729467856ea7dfcaf37833`. Comparing against upstream
without that index would combine independent improvements.

## Reproduction

Build an immutable PR1 checkout and the candidate with Node 26 and their pinned
lockfile dependencies. Use an external output directory for raw samples and
synthetic fixtures:

```sh
node --experimental-test-module-mocks perf/ensemble/exact-dedup-benchmark.mjs BASE OUTPUT --pilot
node --experimental-test-module-mocks perf/ensemble/exact-dedup-benchmark.mjs BASE OUTPUT --final-head HEAD
```

The pilot has fifteen fresh workers: one A/JavaScript/A/SQL/A round for each of
three cases. The final matrix has five A/head/A rounds for each of fifteen
cases. Exploration transforms only the compiled pipeline module and records
original and executed hashes. Final candidate measurements load its actual
compiled source. Every seed and lookup worker's stdout, stderr, exit status and
driver hash are saved externally before interpreting its result, including
failures.

The actual migrated SQLite database and public `checkNewCandidateMatch` pipeline
run in every worker. Only the external assessment boundary and explicitly
labeled filesystem instrumentation are replaced. Immutable fixtures are cloned
into disposable databases; initial/final full row digests and original file
checksums must agree. Setup and post-timing correctness verification are
excluded from lookup timing and identified separately in the output.

## Workloads and limits

- Full matching 1M memberships: 1/2/5 aliases, repeat factors 1/10, constant
  filesystem results. This measures SQL/pipeline CPU, memory and production
  probe invocation counts, without measuring filesystem latency.
- Real filesystem: 1M total rows, twenty matching memberships, ten repeats,
  1/2/5 aliases and 0/5/50ms synthetic delay per access/stat invocation. Report
  selected cardinality separately from total table size. Delays do not establish
  NFS/ZFS behavior.
- Output checks retain the first of two physical episode sources; actual query
  tuples receive a collision-safe ordered digest after lookup timing.
- CPU, RSS and event-loop delay/utilization are local synthetic measurements.
  Loopback HTTP calls exercise the actual compiled Fastify `baseApiPlugin`
  `/api/ping` route; source and compiled route hashes are recorded. A short
  lookup may yield too few ping or event-loop observations for a stable
  percentile.
- Suppression changes filesystem observation frequency within one lookup. A file
  appearing, disappearing or changing between exact repeated memberships will
  not be observed repeatedly. Distinct memberships and subsequent lookups still
  check independently. Refresh and filesystem access are not atomic.

## Pilot selection and pending acceptance

The completed three-case pilot selected SQL grouping of all five recorded
fields, ordered by the earliest matching rowid, over a JavaScript identity Set.
The SQL candidate returned fewer rows to JavaScript in the duplicate-heavy
fixture and avoids retaining a second full membership Set. All three pilot
groups preserved full tuple order, assessed output and the complete stored-row
digest.

With two aliases and constant filesystem results, SQL's duplicate-heavy 1M-row
lookup took 1314ms versus a 2693ms baseline median. The duplicate-free 1M-row
stress case regressed from 2537ms to 3453ms (about 36% wall time and 29% CPU).
JavaScript took 6984ms in the duplicate-free case and 3578ms with repeats. These
are one candidate sample per case against three baseline samples, not final
performance acceptance or a claim about production workloads.

The real-filesystem case selected twenty of 1M stored rows with ten repeats and
50ms synthetic delay per probe. SQL reduced access/stat calls from 20/21 to 2/3
and lookup time from a 2117ms baseline median to 261ms. These delays do not
measure NFS or ZFS.

The selected SQL implementation passed focused eight-test regression coverage
and the full seventy-two-test workspace suite, formatting, build, lint and
typecheck on Node 26.11.1. The five new tests first failed on the original
repeated access counts. A small structural fixture confirmed equal
JavaScript/SQL/native outputs and unchanged stored rows. These checks are
correctness evidence, not performance acceptance. The first final SQL full-suite
run hit the existing injection test's async deletion race at
`full-app.test.ts:329`; its focused rerun and the complete seventy-two-test
rerun passed. No unrelated injection code or test was changed.

Remaining gates are review of the final SQL implementation, five-round native
baseline/head/baseline results, disclosure of regressions above 5%, and fork
platform CI. Constant-result duplicate-free cases can expose added
tuple/grouping costs; operation-count reductions alone cannot justify a
universal speedup. No production database or filesystem has been measured or
changed.
