#!/bin/sh
# Local synthetic one-run functional validation; never comparative performance.
set -eu
: "${BENCH_IMAGE:=cross-seed-root-performance-zfs:baseline-3cf38d2-arm64}"
: "${SMOKE_OUTPUT:?fresh private evidence directory required}"
: "${SMOKE_PROJECT:?fresh codex-zfs-smoke project name required}"
case "$SMOKE_PROJECT" in codex-zfs-smoke-*) ;; *) exit 64 ;; esac
if [ -e "$SMOKE_OUTPUT" ]; then echo 'Fresh smoke evidence directory required' >&2; exit 64; fi
umask 077
mkdir -p "$SMOKE_OUTPUT/media"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export SNAPSHOT_VOLUME="$SMOKE_PROJECT-snapshot"
export RESULTS_VOLUME="$SMOKE_PROJECT-results"
export RUN_ID=synthetic-functional
export MEDIA_ROOT_ON_HOST="$SMOKE_OUTPUT/media"
export MEDIA_ROOT_IN_DAEMON=/media
export CANDIDATE_WORKER=0
export BENCH_OPERATIONS=2
export RPC_DELAY_MS=0
export BENCH_IMAGE
if docker volume inspect "$SNAPSHOT_VOLUME" >/dev/null 2>&1; then echo 'Snapshot name already exists' >&2; exit 64; fi
if docker volume inspect "$RESULTS_VOLUME" >/dev/null 2>&1; then echo 'Results name already exists' >&2; exit 64; fi
docker volume create "$SNAPSHOT_VOLUME" > "$SMOKE_OUTPUT/snapshot-volume.txt"
docker run --rm --entrypoint node --env SYNTHETIC_SMOKE=1 --env SNAPSHOT_IS_DISPOSABLE=1 \
  --mount "type=volume,src=$SNAPSHOT_VOLUME,dst=/snapshot" \
  --mount "type=bind,src=$MEDIA_ROOT_ON_HOST,dst=/media" \
  "$BENCH_IMAGE" /opt/root-performance/dependencies/scripts/root-performance/zfs/seed-smoke.mjs > "$SMOKE_OUTPUT/seed.log" 2>&1
docker compose -p "$SMOKE_PROJECT" -f "$script_dir/compose.yaml" config > "$SMOKE_OUTPUT/compose-resolved.yaml"
set +e
docker compose -p "$SMOKE_PROJECT" -f "$script_dir/compose.yaml" up -d > "$SMOKE_OUTPUT/start.log" 2>&1
started=$?
set -e
if [ "$started" -ne 0 ]; then
 docker compose -p "$SMOKE_PROJECT" -f "$script_dir/compose.yaml" logs --no-color > "$SMOKE_OUTPUT/startup-failure.log" 2>&1
 docker compose -p "$SMOKE_PROJECT" -f "$script_dir/compose.yaml" down > "$SMOKE_OUTPUT/stop.log" 2>&1
 exit "$started"
fi
set +e
docker compose -p "$SMOKE_PROJECT" -f "$script_dir/compose.yaml" wait daemon > "$SMOKE_OUTPUT/daemon-exit.txt" 2>&1
code=$?
set -e
# Only this synthetic stack is inspected/stopped; retain its volumes/evidence.
docker compose -p "$SMOKE_PROJECT" -f "$script_dir/compose.yaml" ps -a --format json > "$SMOKE_OUTPUT/containers.json"
docker compose -p "$SMOKE_PROJECT" -f "$script_dir/compose.yaml" logs --no-color > "$SMOKE_OUTPUT/containers.log" 2>&1
for service in fixture controller daemon; do
 container=$(docker compose -p "$SMOKE_PROJECT" -f "$script_dir/compose.yaml" ps -a -q "$service")
 docker inspect "$container" > "$SMOKE_OUTPUT/$service-inspect.json"
done
docker run --rm --entrypoint node --mount "type=volume,src=$RESULTS_VOLUME,dst=/results,readonly" "$BENCH_IMAGE" --input-type=module --eval '
import {readFile,writeFile} from "node:fs/promises";
let result;
for(let attempt=0;attempt<100;attempt++){try{result=JSON.parse(await readFile("/results/synthetic-functional/aggregate.json","utf8"));if(result.cgroup||result.cgroupCaptureUnavailable)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
console.log(JSON.stringify(result??{success:false,aggregateUnavailable:true}));
if(!result?.success||!result?.cgroup)process.exitCode=1;
' > "$SMOKE_OUTPUT/aggregate.json" 2> "$SMOKE_OUTPUT/aggregate-read.log" || code=1
docker compose -p "$SMOKE_PROJECT" -f "$script_dir/compose.yaml" down > "$SMOKE_OUTPUT/stop.log" 2>&1
exit "$code"
