# Source consistency implementation plan

**Goal:** repair source identity and publication before extending
synchronization or database execution. **Architecture:** ordered client leases
guard cache writes; source-owned memberships replace nullable identity;
transactions publish health invalidation only after committed changes. **Spec:**
[approved design](source-consistency-design.md)

The user approved local implementation on 2026-10-13. Production migration and
upstream submission remain separate decisions. This dedicated clone is isolated
from the Mayor checkout; work proceeds on `repair-source-publication`,
preserving the design baseline.

## Global constraints

- Node 26, pinned dependencies; no changes to borrowed dependency installations.
- No production DDL or writable media access. Use disposable database copies.
- Raw benchmark captures stay outside source diffs and are linked from fork PR
  descriptions.
- All timing runs are serialized and pin source, compiled artifacts and fixture
  shape.
- Aggregate telemetry excludes names, hashes, tracker URLs, credentials and
  private paths.

## Review focus

- An older full catalog must not overwrite or remove a newer scoped result.
- Successful early batches must invalidate health even if a later batch fails.
- Adding a reverse-proxy client must not rename an existing namespace.
- Source replacement must preserve aliases and other owners of a physical path.
- Interrupted migration and unavailable sources must retain recoverable data.

## 1. Ordered cache publication

Files: `clientCachePublication.ts`, `searchee.ts`, four client adapters, cache
and targeted-refresh tests.

- [ ] Add barrier-controlled real qB races in both completion orders and a
      SQL-trigger late batch failure; preserve failing output.
- [ ] Begin namespace leases before RPC; serialize atomic batch commits, track
      accepted source revisions and authoritative completion, reject stale
      writes/pruning, retry scoped conflicts explicitly.
- [ ] Emit shared health invalidation after each committed mutation, never
      before commit.
- [ ] Run cache, qB, health integration tests and typecheck.

## 2. Stable source storage

Files: `sourceStore.ts`, migration 19/registry, source-store tests, client
factory, data/torrent writers and cleanup consumers.

- [ ] Test stable credentialless endpoint identity, aliases, multiple owners,
      idempotent replacement, empty/unavailable distinction, revision checks and
      rollback.
- [ ] Introduce namespaces/origins/aliases/paths/memberships with non-null
      uniqueness and atomic source replacement.
- [ ] Import only exact historical groups with minimum row order into unknown
      origins; preserve legacy originals and do not infer lost aliases.
- [ ] Integrate all writers/readers only after their storage API is validated;
      remove query grouping on repaired lookups.
- [ ] Validate cloned real shape and 1.4-million-row capacity fixture without
      modifying the original backup.

## 3. Representative measurement tooling

Files: new `scripts/root-performance/` utilities and concise documentation.

- [ ] Separate fake qB serialization and HTTP load generation from daemon
      CPU/memory.
- [ ] Record controlled active-window requests, misses/timeouts/generator lag;
      constrain the daemon and workers to 2 GiB with swap disabled.
- [ ] Preserve A/B/A worker pinning and add source-shaped file/season fixtures
      plus independent cleanup ablations.
- [ ] Smoke test tools, then serialize baseline/candidate measurements after
      source freeze.

## 4. Subsequent root-performance projects

- [ ] Incremental qB rid state: complete bootstrap, valid delta removal,
      restart/lost-state recovery and retained deep file/tracker validation.
- [ ] Privacy-safe aggregate invocation telemetry, with whitelist tests.
- [ ] Database worker ownership/transaction scheduling and bounded
      generation/decoding; compare responsiveness and lock contention.
- [ ] Disposable TrueNAS ZFS benchmark alongside the existing service, with
      read-only media and strict memory cap.

## Delivery

- [ ] Full clean functional/type/lint gates and independent review.
- [ ] Publish immutable aggregate benchmark evidence and create separate fork
      PRs; attach each PR to this task.
- [ ] Report measured benefits and regressions without crediting combined
      results to unrelated changes.
