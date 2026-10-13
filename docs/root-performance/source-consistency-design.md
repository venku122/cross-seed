# Source consistency and root performance repair

Status: approved for local implementation on 2026-10-13. Source/cache repairs
and isolated tests are underway. Production migration has not been performed.

## Goal and boundaries

Fix source identity and cache consistency first, then remove unnecessary full
refresh work and isolate synchronous database/decoding work. The outcome must
preserve legitimate titles, clients and source ownership; reduce measured CPU
and memory; and keep daemon requests responsive under a strict memory limit.
Faster designed fixtures alone are insufficient acceptance.

This first project implements source ownership, ordered cache publication and
safe migration in isolated copies. Incremental qB sync and worker execution are
subsequent projects with the interfaces below as their common boundary. All
application changes go to the user's fork for review. Production migration,
upstream submission and maintainer messages remain separate human decisions.

## Fresh confirmation

The local combined tree is a9ba6f5e; production sources are unchanged from
12464ec1. Upstream master remains 8a0c428e. Node 26.11.1/SQLite 3.53.4 compiled
cache functions and 49 focused existing tests were checked again.

The actual compiled writer contract reproduces three defects:

1. A complete catalog captured before a scoped refresh can overwrite its newer
   save path when the complete update commits later.
2. That older catalog can remove a row added by the newer scoped refresh.
3. An injected SQL failure after the first 100-row batch leaves 100 committed
   rows, but the health generation does not change. Invalidation currently
   occurs only after the entire helper returns successfully.

The composed tree already shares the scoped UPSERT helper and has invalidation
tests. It also has a compiled runtime smoke for refreshOne. The missing
guarantee is ordering and failure handling, plus a regression that combines the
actual scoped HTTP operation with the subsequent health diagnostic result.

The private, read-only cold snapshot contains 31,329 memberships, 12,665
distinct tuples and 18,664 repeats. Its 820 ensemble-key groups become 730
groups of 1–24 memberships and 90 groups of 25–100; the maximum distinct group
is 72. Candidate keys can combine several groups. These are stored-data shapes,
not invocation weights. Cached file counts: 4,971 one-file torrents, 2,869 with
2–24 files, 292 with 25–100,50 with 101–1,000,10 with 1,001–10,000 and2 above
10,000.

Evidence is aggregate-only in confirmation/. The cache probe uses synthetic
arguments to real exported writers, not an actual concurrent qB transport; the
implementation tests must add that transport race explicitly.

## Alternatives and recommendation

| Approach                                                                              | Benefit                                                 | Limitation                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| More main-thread paging and query grouping                                            | Small code changes                                      | Leaves identity defects, repeated hydration and final synchronous stalls  |
| Source-aware persistence, ordered publication, incremental producers, database worker | Repairs correctness and provides a path to bounded work | Requires migration and explicit transaction/connection ownership          |
| External database service/process for all storage                                     | Strong isolation                                        | Adds deployment and recovery complexity before its benefit is established |

Choose the second approach in independent stages. PR #8's query grouping remains
suspended as an experimental mitigation; the repaired store should use indexed
memberships without grouping every lookup. PR #6/#9 remain drafts until ablation
and memory gates support their costs. No current result is credited to PR #4 for
ordinary full cleanup.

## Source identity model

Use explicit namespaces and logical origins. A logical source can contribute
several physical files and alternate titles; two sources can own the same path.

- `source_namespace(id, type, locator, enabled, operation_sequence, last_complete_sequence)`:
  stable ID for a configured client, data root or torrent directory. Its locator
  is private database data. Client normalization always includes endpoint
  pathname and excludes authentication credentials; identity never depends on
  the number or order of configured clients.
- `source_origin(id, namespace_id, source_key, revision, state, metadata)`:
  UNIQUE(namespace_id,source_key), with non-null keys. Metadata persists enough
  to reconstruct a searchee, including files, title and source placement.
- `source_alias(namespace_id, alias, origin_id)`: resolves primary/v1/v2 torrent
  hashes within one client namespace. Merge identities only after authoritative
  metadata establishes equivalence; never across clients.
- `physical_path(id,path)`: lexical daemon-visible path, not inode identity.
  Symlinks, hardlinks and case variants are not silently collapsed.
- `ensemble_membership(origin_id,path_id,ensemble,element,selection_order)`:
  PRIMARY KEY(origin_id,path_id,ensemble,element). Client/hash metadata remains
  associated with its origin rather than serving as a nullable uniqueness key.

Client source keys resolve to stable origin IDs through the alias mapping.
Data/torrent-file keys use their namespace and lexical relative input path (file
or searchee directory). Credential or presentation-label changes retain
identity. Endpoint changes create a new namespace unless an explicit rebind is
provided. A verified source move is a transition; arbitrary shared inodes do not
prove that a rename occurred.

An important current behavior to eliminate: clientHost changes from host to
host+pathname when another client uses that host. Stable namespace identity must
not change when another reverse-proxy client is added.

## One publication contract for all writers

Every read/refresh gets a monotonically ordered operation lease before its RPC
or filesystem scan. The lease contains namespace ID, operation sequence and
coordinator session. All cache/membership writes use a single mutation service.

Per-source publication atomically writes metadata and replaces only that
origin's memberships. It never updates one representation without the other.
Batches may group several sources in one transaction for efficiency, but a
source is never partially applied. The event that invalidates health is emitted
only after that transaction commits. Every successful batch emits it even if a
later batch fails. A failure cannot leave committed changes invisible to the
health cache.

Commit conditions reject a source operation older than that origin's accepted
operation, or older than a newer completed authoritative snapshot. Rejected
on-demand operations retry with a fresh lease; exhausted retries return an
explicit concurrency error rather than NOT_FOUND or stale metadata.

A full snapshot stages a complete set of seen origin IDs. Removal is permitted
only after successful validation/completion, only for this namespace, and only
for origins not changed by a later operation. A superseded snapshot cannot prune
newer additions or publish older placements. Tombstones protect removed origins
from late responses; they can be collected after all older leases end.
Process/coordinator restart invalidates old-session leases.

Successful earlier batches can remain if a later source fails. The job reports
partial progress and does not perform authoritative removals. This promises
atomic source publication, not an all-or-nothing transaction over a long full
client refresh. The qB API's multi-request metadata is also not a remote
transaction; changed source fingerprints require revalidation/retry.

`getClientSearchees` remains a compatibility collector. New cleanup/indexing
consumers use cached source iteration, so stale RPC arrays are not fed directly
into a later membership write. Generation inherits the source revision and
cannot overwrite a newer placement. The mutation service is shared by client
refresh, torrentDir indexing, dataDir startup/watchers and cleanup pruning.

Generation distinguishes successful empty membership output from unavailable
paths/failed RPCs. Only the former replaces that source with no memberships.
Unavailable or ambiguously empty mounts preserve source state and report it. An
accessible empty directory alone does not prove that an NFS root is healthy.
Disabled sources are hidden from lookup and retained for recovery; bulk disposal
is a separate policy, not inferred from one failed enumeration.

## Migration, ordering and rollback

Initial implementation is exercised against disposable files and private copies.
Never attach a writable migration connection to the backup or production DB.

Import exact legacy tuples in MIN(rowid) order into explicit legacy-unknown
origins. This removes repeated active memberships without inventing provenance.
Retain selection_order for existing tuples and use a deterministic tie policy.
Authoritative rebuild creates real origins and restores aliases from complete
source metadata. Lost named-host aliases cannot be recovered from ensemble rows
alone; missing roots/clients leave that part unresolved and clearly marked.

Promotion requires matching known-source ordering, successful integrity/FK
checks, idempotent refreshes and explicit accounting for unresolved legacy
entries. Preserve a consistent original database and compatible old code. No
down migration may silently squeeze new multi-alias ownership back into the old
nullable(host,path) key. Rollback restores the preserved database and code.
VACUUM and disposal of the old table/backup are separately measured maintenance,
not an automatic side effect of the first migration.

Read-only coordination research: issue #1068 proposes separating provider writes
from cached reads using list():AsyncIterable. Draft #1088 at 19f3855 persists
searchee fields in a library table; it does not provide this ownership/version
contract. Keep metadata persistence compatible with that direction and prepare a
design note for maintainers. Sending it still requires user authorization.

## Interfaces for the next performance stages

Incremental qB synchronization owns one ordered rid state per namespace and
merges partial torrent fields. Reset/restart or full_update triggers complete
inventory validation; omitted fields are unchanged, never deletion. Only an
accepted torrents_removed event or a validated complete snapshot removes a
source. Persist inventory/cursor coherently; retry failed detail hydration
without falsely removing the torrent. Force-deep refresh remains for file and
tracker changes invisible to cheap fields. Cached list() is independent of
refreshAll(), following the upstream source abstraction.

Move SQLite to an explicitly owned worker connection behind an async adapter.
Transactions have leases; no unrelated command interleaves between BEGIN and
COMMIT. TEMP state is owned by that same connection/session, with tests for
restart, errors and invalid pool configuration. Measure read contention before
adding a separate WAL reader. Moving SQL must not merely move its queue delay to
every API route. Extract pure membership generation and decode client JSON
outside the daemon thread; avoid cloning complete catalogs/file arrays through
worker messages. Cleanup consumes bounded source pages.

Health separates cheap last-known operational status from deep filesystem/dbstat
diagnostics. Show distinct status and diagnostic timestamps, unknown/stale state
and failures. A regular sidebar poll does not start full catalog hydration or
linking probes. Manual deep refresh retains current IDs/severities and cleanup.
Preserve remote observations and TTL semantics in no-tab, one-tab expired-cache
and multi-tab tests, rather than improving only immediate bursts.

## Required correctness and performance evidence

Correctness gates include actual gated qB HTTP races in both completion orders,
warm health→scoped move→changed diagnostic, late SQL failure/invalidation,
restart/superseded snapshots, alias identity, credential/proxy configuration
changes, overlapping roots, multiple clients sharing paths, source move/remove,
unavailable roots and interrupted migration/promotion. Run the existing suite.
Use the 18,664-repeat shape plus 1.4M-row stress fixtures; restore lost aliases
in explicit golden cases, not by claiming unchanged output where a bug is fixed.

Benchmark active repaired storage at observed season cardinalities (1–24,25–72,
multiple combined keys), retaining 1M-table stress as a separate capacity test.
Shape file counts and JSON bytes from privacy-safe histograms, including the
rare large sources. Actual operation frequencies still require telemetry.

Telemetry has a strict field whitelist: fixed job/component type, durations,
file/row-count buckets, cache hits/misses, RPC decoded bytes, query counts,
event-loop delay and memory/GC measurements. No names, paths, hashes, tracker
URLs, credentials, endpoint labels, source IDs or arbitrary error text.

Heap object snapshots can contain names and credentials. Real-data runs use
aggregate heap/GC measurements and sanitized allocation profiles; object
snapshots are confined to synthetic fixtures and never published from real data.

Use an external fake qB process so server serialization CPU/memory is excluded
from cross-seed attribution. Ablation shares PR #2 as common cleanup base and
compares cache strategy, rebuild strategy, their combination and repaired store.
Test health with zero/one/multiple browsers separately. Keep A/B/A source,
compiled, lock/runtime identities and all failures, with timing serialized.

On TrueNAS, use a disposable file-backed DB and read-only media access, no
inject/delete/tag APIs. Fixture generation and HTTP load generation live outside
the capped daemon container. Cap it at 2 GiB with swap disabled; include workers
in cgroup memory. Record memory.peak, OOM events, CPU, heap/GC profiles and main
event-loop delay. Preserve cap failures; do not quietly increase the limit.
Collect thousands of externally generated, rate-controlled pings during active
refresh windows, including attempts, timeouts and generator scheduling lag.
Measure latency distributions by phase; idle samples must not dilute stalls.

Provisional acceptance: no correctness mismatch, no OOM at 2 GiB, substantially
lower whole-job CPU/memory on representative fixtures, and active-refresh ping
p99 below 50 ms with bounded maxima. These are targets, not claims or hard
real-time guarantees. Record any non-passing gate and keep that branch draft.

## Review decisions

Approve the stable namespace/origin model, request-ordered conditional
publication and safe legacy-unknown migration first. Then implement it on an
isolated local branch and fork PR with regression evidence. Keep current
production untouched. Incremental sync and worker execution follow independently
through this contract; their experiments must demonstrate attribution, not rely
on combined medians.

References:

- https://github.com/cross-seed/cross-seed/issues/1068
- https://github.com/cross-seed/cross-seed/pull/1088
- https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29#sync
