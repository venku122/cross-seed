#!/bin/sh
# Record cap failures even when Node is killed; raw artifacts remain private.
umask 077
case "$RUN_ID" in ''|*[!a-zA-Z0-9_-]*) exit 64 ;; esac
result_dir="/results/$RUN_ID/private"
mkdir -p "$result_dir"
if [ "${BENCH_PROFILE:-0}" = 1 ]; then
 mkdir -p "$result_dir/profiles"
 set -- --cpu-prof --cpu-prof-dir="$result_dir/profiles" --cpu-prof-interval=1000 --heap-prof --heap-prof-dir="$result_dir/profiles" --heap-prof-interval=32768
else
 set --
fi
node "$@" /opt/root-performance/dependencies/scripts/root-performance/zfs/daemon.mjs > "$result_dir/stdout.log" 2> "$result_dir/stderr.log"
code=$?
cat /sys/fs/cgroup/memory.peak > "$result_dir/memory.peak"
cat /sys/fs/cgroup/memory.events > "$result_dir/memory.events"
cat /sys/fs/cgroup/cpu.stat > "$result_dir/cpu.stat"
printf '%s\n' "$code" > "$result_dir/exit-code"
exit "$code"
