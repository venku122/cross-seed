# TrueNAS read-only full-cleanup harness

Review the frozen source, private snapshot/configuration, media mount mappings,
images and rollback boundaries before each deployment. The harness has run on
TrueNAS with disposable databases, read-only ZFS media and a strict 2 GiB daemon
cap. Client transport is a frozen replay; it does not contact production
clients. No production service, database or client is a writable benchmark
target. Private evidence stays outside source diffs. This Compose template still
needs site-specific deployment review; the recorded runs used an equivalent
isolated Docker configuration.

## Frozen source images and Linux dependency resolution

The dependency images install exact current-lock dependencies in
`/opt/root-performance/dependencies`, with Node26.11.1 and TypeScript5.9.3.
`prepare-source-image.mjs` makes a fresh source-only copy, excluding every
node_modules, dist, .git, .env and build-info artifact. The image compiles that
copy with Linux TypeScript. It also recreates borrowed macOS absolute dependency
symlink targets **inside the image**, pointing to the Linux-installed equivalent
workspace directories. This makes the existing capped runner's read-only host
checkout mounts resolve Linux dependencies rather than missing Darwin targets.
It never copies Darwin node_modules. npm workspace links point to Linux source
workspaces, whose shared code is built through TypeScript project references.
Static web assets are borrowed from the prior local runtime image; ping/cleanup
results do not claim a rebuilt frontend. The source image clears the inherited
Node entrypoint so the existing Docker runner can execute its shell command.

After the root confirms a source freeze, for each prebuilt baseline/candidate:

```sh
node scripts/root-performance/zfs/prepare-source-image.mjs "$FROZEN_TREE" "$FRESH_CONTEXT"
docker build --platform linux/amd64 \
  --build-arg DEPENDENCY_IMAGE=cross-seed-root-performance-deps:lock88da-amd64 \
  --tag "$SOURCE_IMAGE" "$FRESH_CONTEXT"
```

Use the arm64 dependency tag for a native local ARM image; amd64 emulation is
functional validation, not representative TrueNAS timing. All image builds and
emulation checks must finish before the comparative slot opens. Preserve source
and dependency manifests, image IDs and all failures. Current-lock dependencies
were installed only in the isolated image, with lifecycle scripts disabled; no
current checkout received npm ci. Native addons needing installation scripts
must be checked separately before relying on them; this storage path uses Node's
built-in SQLite. For clean isolated CI, create a disposable container from the
source image, work in `/opt/root-performance/dependencies`, and unset CONFIG_DIR
before tests. No writable host source mount is required. Caller-owned harness
files are staged separately on every source image, including baselines that do
not contain the new tooling; their identity manifest is separate from baseline
source.

The existing controller accepts `--candidate-worker` to enable
CROSS_SEED_SQLITE_WORKER=1 exclusively for B; A1/A2 neutralize inherited worker
settings. Baseline PR2 versus composed pre-root versus root synchronous versus
root worker can use separate fresh A/B/A outputs with identical
count/file/season, operation, runtime and lock settings. The worker comparison
is the same frozen root candidate with and without the flag; do not attribute
combined changes to an individual cache/rebuild PR. Existing capped runner takes
one BENCH_NODE_IMAGE per invocation; compare separately or add reviewed
per-phase image selection before attempting distinct image-backed A/B/A. Source
mounts retain the measured compiled modules; image workspace shared code must
match every compared tree.

## Private cold fixture and source identity

The read-only snapshot volume must contain a consistent standalone DB backup.
`SNAPSHOT_DB` defaults to `/snapshot/cross-seed.db`; set it explicitly for an
existing volume layout. `PRIVATE_CONFIG` defaults to
`/snapshot/benchmark-config.json` for smoke, or can point to
`/private-input/benchmark-config.json` in the new results volume mounted as a
separate read-only input alias. This supports an unchanged old snapshot volume
without adding files to it. A private staged cold input permits SQLite WAL
reader sidecars without writing to the original read-only volume; nonempty WAL
sidecars are rejected until an explicit consistent bundle workflow is provided.
The daemon uses SQLite backup() from a read-only staged-input connection to make
a fresh file-backed DB under a new results run, then migrates only that
disposable copy outside timing. Do not attach writable connections to the
snapshot. A run ID must be new; do not reuse an interrupted DB. The daemon
refuses an existing config directory, and the controller refuses existing result
artifacts. Client refresh failures swallowed/logged by cleanup are captured by
adapter wrappers and make success false. Private normalized cache semantic and
visible membership/deduplicated/selection digests are recorded in bounded pages;
they are evidence for reviewed comparisons, not an assertion that known
corrected named-host alias loss must match the old output. Snapshot metadata,
source mappings and lexical paths are private artifacts.

Private config shape:

```json
{
	"dataDirs": ["/daemon-visible/read-only/media-root"],
	"seasonFromEpisodes": 1,
	"mediaSentinels": [
		"/daemon-visible/read-only/media-root/reviewed-nonempty-file"
	],
	"clients": [
		{
			"clientHost": "exact cached client_host",
			"sourceLocator": "http://original-configured-host/original-proxy-path"
		}
	]
}
```

Source locators must omit credentials. Constructing actual qB adapters with
their original configured endpoint/path preserves the repaired namespace
identity. A harness transport gate redirects every qB request to the private
snapshot fake RPC; it rejects any destination outside that mapping/controller.
No live client is contacted. Include every cached client host; do not silently
assign missing sources to a fabricated identity. Snapshot reconstruction is
stored-cache shaped, not proof of qB's real invocation frequencies or changed
remote metadata.

## Container boundaries and cap

`compose.yaml` uses an internal Docker network with no published ports and no
Docker socket. Actual compiled serve()/api/ping runs at daemon:4040. The
external snapshot fake qB listens at fixture:4041 and pre-serializes catalog
JSON outside the daemon cgroup. The external controller/load generator listens
at controller:4042. The generator warms its own fetch/keepalive path with one
ping before signaling readiness; that idle warmup is excluded from active
samples. Only the daemon container has a 2 GiB memory / zero-swap cap; all of
its workers belong to that cgroup. Fixture/controller/load generation is
excluded from daemon attribution. Media and snapshot mounts are read-only; only
the fresh results volume is writable. Adjust reviewed media mount mappings to
preserve all cached daemon-visible lexical paths; a wrong mount is a failed
fixture, not proof that production files were deleted.

The daemon calls actual compiled cleanupDB and real access() without filesystem
mocks. It uses read-only qB adapters and a fake server that rejects write/tag/
injection/deletion endpoints. The cold DB clone is the only writable store. The
shell records memory.peak, memory.events, cpu.stat and exit code even if Node is
killed; the external controller subsequently publishes only whitelisted numeric
cgroup counters. Profile files are optional and private, with sanitized
fixed-stage summaries added only after daemon exit. OOM/cap failures stay
failures; never increase the cap. Root must also capture actual container image
identity/state/exit/OOM from Portainer because a whole-cgroup kill can prevent
the shell's final capture.

Set `BENCH_OPERATIONS` identically across phases to repeat cleanup consecutively
and collect thousands of active pings. Optional `RPC_DELAY_MS` applies the same
external replay delay to all qB read calls; it is explicitly labeled replay
delay, not measured real-client latency. Profile isolate attribution is labeled
unknown until per-isolate profile filenames are reviewed.

## Open gates

Startup retries, complete cached-client mapping validation, nonempty read-only
media sentinels and explicit load admission stop before integrity diagnostics
are implemented. This draft still needs per-phase image/worker scheduling and
end-to-end transport/container smoke before deployment. No performance
acceptance is claimed. The controller timeout preserves a failure aggregate but
does not manage Docker; root must inspect/stop only the reviewed disposable
benchmark containers. Profile/raw identifier artifacts remain private; real-data
object heap snapshots are prohibited. No deployment or timed comparative run is
authorized by this file.

## Local synthetic functional smoke

`smoke-local.sh` creates only fresh `codex-zfs-smoke-*` local containers/volumes
and synthetic media. It seeds a disposable snapshot, runs two real compiled
cleanup operations with read-only media, checks the aggregate/cgroup capture,
then removes only its containers/network and preserves volumes/evidence. Use a
fresh evidence directory and project name:

```sh
BENCH_IMAGE="$REVIEWED_NATIVE_SOURCE_IMAGE" \
SMOKE_OUTPUT="$FRESH_PRIVATE_EVIDENCE_DIRECTORY" \
SMOKE_PROJECT=codex-zfs-smoke-unique \
  sh scripts/root-performance/zfs/smoke-local.sh
```

This is functional validation, never comparative timing or TrueNAS acceptance.
The first local smoke retained a readonly-WAL startup failure; the second passed
with zero failed refreshes/forbidden RPCs, HTTP attempts fully accounted for and
cgroup counters captured. Root still owns real-snapshot mapping review,
corrected alias golden cases, capped representative A/B/A, exact image/source
identity checks and production deployment gates. Do not reuse the smoke fixtures
as a representative workload.
