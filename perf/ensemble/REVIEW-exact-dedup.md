# Exact membership lookup review

The root agent independently reviewed the selected SQL diff and regression tests
before granting the native final timing matrix. No correctness blocker was
found. The measured implementation remains a draft candidate because the
duplicate-free pilot regressed; actual invocation weighting and platform
evidence remain gates.

Reviewed source:

- Base includes PR1's ensemble index and source-order fix at
  `17a779988c496d2bc0729467856ea7dfcaf37833`.
- Candidate pipeline source SHA256:
  `5024c4437ce041ceaee2cacb4d8ed8b68a71786f355fc560b9d18661e111c66f`.
- Candidate compiled pipeline SHA256:
  `fb413c7f50544eb6226b1868ae4524083f94e65fd075645ef171e91aebb9e7f7`.
- Final timing controller SHA256:
  `55e66381737217e77f0d31ddbf26c5c3f4ba52269828fb5abb4f1d691dcb9491`.

## Correctness findings

Grouping all five recorded fields suppresses exact repeat memberships before
filesystem access. SQL distinguishes NULL from empty host/hash strings and does
not concatenate values into a delimiter-sensitive identity. Different aliases,
recorded hosts/hashes and episode elements remain separate memberships.

Ordering groups by MIN(rowid) retains each membership's earliest source
position. The existing episode-source selection then keeps its first physical
file as before. Grouping does not replace that later selection rule or create a
source provenance identifier absent from the schema.

Missing-file processing retains the existing path-wide deletion from data and
ensemble. A subsequent lookup observes filesystem state again. No persistent
filesystem cache, schema migration or stored duplicate cleanup is introduced.

The regression file covers exact repeats, per-lookup reset, recorded host/hash
distinctions, NULL versus empty host, alternate aliases, delimiter-containing
values, different elements, first physical source order and missing-path
cleanup. Five new tests first failed on the old repeated access counts. The
final SQL full workspace rerun passed all 72 tests and
format/build/lint/typecheck gates. An earlier full run hit the preexisting
injection test's async unlink race; focused and complete reruns passed, with no
unrelated change hidden in this branch.

## Limits and unresolved acceptance

Filesystem observations are not atomic. Exact repeated rows no longer re-observe
a file appearing, disappearing or changing during one lookup. Distinct
memberships still observe independently; a later lookup starts fresh.

SQL grouping and ordering add work when there are no exact duplicates. The
pilot's 1M matching row, two-alias constant-filesystem case increased wall time
about 36% and CPU about 29%. The JavaScript implementation alternative also
regressed and retained an additional membership Set. SQL won the duplicate-heavy
pilot on wall/CPU/heap, but that does not justify a universal speedup claim.

The completed final native matrix contains 225 successful workers. It uses five
fresh-process A/head/A rounds per case, actual migrated SQLite and the public
compiled pipeline. Loopback calls use the actual compiled Fastify /api/ping
route. Full-match 1M cases use labeled constant filesystem results;
real-filesystem slow cases select only twenty of 1M rows and add synthetic
delays. These experiments do not measure production NFS/ZFS or establish the
prevalence of duplicate lookups.

The controller preserves every seed/lookup stdout, stderr and termination status
before interpreting results, with 180-second seed and 120-second lookup
deadlines. The earlier stalled real-filesystem pilot was a live mock-export
reference issue; its partial and failed worker evidence was preserved, native
function references were captured before mock installation, and a fresh complete
pilot passed.
