import { fork, spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	appendFileSync,
	existsSync,
	unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { adaptWorker } from "./adapt-worker.mjs";
import { publish, publishHttp, publishProfiling } from "./privacy.mjs";
const args = process.argv.slice(2);
if (args.length < 3)
	throw new Error(
		"Usage: node run-aba.mjs BASELINE CANDIDATE OUTPUT [--docker] [--candidate-worker]",
	);
const [baseline, candidate, destination] = args
	.slice(0, 3)
	.map((value) => resolve(value));
import { claimComparativeSlot } from "./slot.mjs";
import { collectPrivateProfiles } from "./profiling.mjs";
import { workerEnvironment, workerDockerFlags } from "./worker-mode.mjs";
const candidateWorker = args.includes("--candidate-worker");
const capped = args.includes("--docker");
const profiled = process.env.BENCH_PROFILE === "1";
const profilerSettings = {
	enabled: profiled,
	cpuSampleIntervalUs: 1000,
	heapSampleIntervalBytes: 32768,
	memoryIntervalMs: 10,
	gcScope: "active-window",
	rawProfileScope: "isolate-unclassified",
	objectHeapSnapshots: false,
};
if (existsSync(join(destination, "samples.jsonl")))
	throw new Error("Use a fresh output directory");
mkdirSync(destination, { recursive: true });
mkdirSync(join(destination, "private"), { mode: 0o700 });
const here = fileURLToPath(new URL(".", import.meta.url));
const original = readFileSync(
	new URL("../benchmarks/combined-cleanup.mjs", import.meta.url),
	"utf8",
);
const worker = join(here, `.external-worker-${process.pid}.mjs`);
const source = adaptWorker(original);
writeFileSync(worker, source);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fixtures = (process.env.BENCH_SHAPES ?? "1,12,72,10001,observed").split(
	",",
);
const rounds = Number(process.env.BENCH_ROUNDS ?? 5),
	count = Number(process.env.BENCH_COUNT ?? 8194),
	operations = Number(process.env.BENCH_OPERATIONS ?? 1);
if (
	!Number.isSafeInteger(rounds) ||
	rounds < 1 ||
	!Number.isSafeInteger(count) ||
	count < 1 ||
	!Number.isSafeInteger(operations) ||
	operations < 1
)
	throw new Error("Invalid matrix");
const pinned = new Map();
const semantic = new Map();
const identity = (repo) => {
	const files = execFileSync(
		"rg",
		[
			"--files",
			"--no-ignore",
			"cross-seed/src",
			"cross-seed/dist",
			"package-lock.json",
		],
		{ cwd: repo, encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(Boolean);
	const dist = [];
	return digest(
		JSON.stringify(
			[...new Set([...files.map((f) => join(repo, f)), ...dist])]
				.sort()
				.map((f) => [
					f.startsWith(repo) ? f.slice(repo.length) : f,
					digest(readFileSync(f)),
				]),
		),
	);
};
async function external(name, args) {
	const child = fork(new URL(name, import.meta.url), args, {
		stdio: ["ignore", "ignore", "inherit", "ipc"],
		env: {
			...process.env,
			...(capped
				? { FIXTURE_BIND: "0.0.0.0", CONTROL_BIND: "0.0.0.0" }
				: {}),
		},
	});
	const [ready] = await once(child, "message");
	return { child, ...ready };
}
let releaseSlot;
try {
	releaseSlot = claimComparativeSlot(
		process.env.BENCH_SLOT_PATH ?? join(here, ".comparative-slot"),
	);
	writeFileSync(
		join(destination, "private", "manifest.json"),
		JSON.stringify(
			{
				node: process.version,
				nodeBinary: digest(readFileSync(process.execPath)),
				originalWorker: digest(original),
				executedWorker: digest(source),
				harnessIdentities: Object.fromEntries(
					execFileSync("rg", ["--files", here], { encoding: "utf8" })
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((file) => [
							file.slice(here.length),
							digest(readFileSync(file)),
						]),
				),
				baseline,
				candidate,
				capped,
				profilerSettings,
				candidateWorker,
				sqliteWorkerPhases: {
					A1: false,
					B: candidateWorker,
					A2: false,
				},
				rounds,
				operations,
				count,
				fixtures,
				seasonShape: process.env.SEASON_SHAPE ?? "same",
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	for (const shape of fixtures)
		for (let round = 0; round < rounds; round++)
			for (const phase of ["A1", "B", "A2"]) {
				const repo = phase === "B" ? candidate : baseline;
				const before = identity(repo);
				if (pinned.has(repo) && pinned.get(repo) !== before)
					throw new Error("Source/dist/lock drift");
				pinned.set(repo, before);
				const fixture = await external("./fake-qb.mjs", [
					String(count),
					shape,
					"1",
				]);
				const control = await external("./control.mjs", []);
				const id = `${shape}-${round}-${phase}`;
				const env = {
					...workerEnvironment(process.env, phase, candidateWorker),
					QB_ORIGIN: fixture.origin,
					LOAD_CONTROL: control.origin,
					BENCH_FILES: shape === "observed" ? "1" : shape,
					BENCH_CLIENTS: "1",
					BENCH_SOURCE_DELAY: "0",
				};
				let result;
				const profileDir = join(
					destination,
					"private",
					id + "-profiles",
				);
				if (profiled) mkdirSync(profileDir, { mode: 0o700 });
				const profileFlags = profiled
					? [
							"--cpu-prof",
							`--cpu-prof-dir=${profileDir}`,
							"--cpu-prof-interval=1000",
							"--heap-prof",
							`--heap-prof-dir=${profileDir}`,
							"--heap-prof-interval=32768",
						]
					: [];
				try {
					let command = process.execPath,
						commandArgs = [
							...profileFlags,
							worker,
							repo,
							String(count),
							"1",
							"0",
							String(operations),
							"refresh",
						];
					if (capped) {
						const image =
							process.env.BENCH_NODE_IMAGE ??
							"node:26.11.1-bookworm-slim";
						// Linux host networking lets capped daemon contact the external fixture/control.
						command = "docker";
						commandArgs = [
							"run",
							"--user",
							`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
							"--name",
							`root-perf-${process.pid}`,
							"--network",
							"host",
							"--memory",
							"2147483648",
							"--memory-swap",
							"2147483648",
							"--pids-limit",
							"128",
							"--mount",
							`type=bind,src=${repo},dst=${repo},readonly`,
							"--mount",
							`type=bind,src=${here},dst=${here},readonly`,
							...(profiled
								? [
										"--mount",
										`type=bind,src=${profileDir},dst=${profileDir}`,
										"--env",
										"BENCH_PROFILE=1",
									]
								: []),
							"--env",
							`QB_ORIGIN=${fixture.origin}`,
							"--env",
							`LOAD_CONTROL=${control.origin}`,
							"--env",
							`BENCH_FILES=${env.BENCH_FILES}`,
							"--env",
							"BENCH_CLIENTS=1",
							"--env",
							"BENCH_SOURCE_DELAY=0",
							...workerDockerFlags(phase, candidateWorker),
							image,
							"sh",
							"-c",
							'node "$@"; code=$?; printf "CGROUP_PEAK "; cat /sys/fs/cgroup/memory.peak; printf "CGROUP_EVENTS "; cat /sys/fs/cgroup/memory.events; printf "CGROUP_CPU "; cat /sys/fs/cgroup/cpu.stat; exit "$code"',
							"worker",
							...commandArgs,
						];
					}
					const child = spawn(command, commandArgs, {
						env,
						stdio: ["ignore", "pipe", "pipe"],
					});
					let stdout = "",
						stderr = "";
					child.stdout.on("data", (chunk) => (stdout += chunk));
					child.stderr.on("data", (chunk) => (stderr += chunk));
					const timeout = setTimeout(
						() => {
							if (capped) {
								try {
									execFileSync(
										"docker",
										["kill", `root-perf-${process.pid}`],
										{ stdio: "ignore" },
									);
								} catch {}
							}
							child.kill("SIGKILL");
						},
						Number(process.env.BENCH_TIMEOUT_MS ?? 180000),
					);
					const [code, signal] = await once(child, "exit");
					clearTimeout(timeout);
					writeFileSync(
						join(destination, "private", `${id}.log`),
						stdout + stderr,
						{ mode: 0o600 },
					);
					if (capped) {
						const inspect = execFileSync(
							"docker",
							["inspect", `root-perf-${process.pid}`],
							{ encoding: "utf8" },
						);
						writeFileSync(
							join(
								destination,
								"private",
								`${id}.container.json`,
							),
							inspect,
							{ mode: 0o600 },
						);
						execFileSync("docker", [
							"rm",
							`root-perf-${process.pid}`,
						]);
					}
					const line = stdout
						.split("\n")
						.find((line) => line.startsWith("BENCH_RESULT "));
					const record = line
						? JSON.parse(line.slice(13))
						: undefined;
					const {
						aggregates: profileAggregates,
						identities: profileIdentities,
					} = profiled
						? await collectPrivateProfiles(profileDir)
						: { aggregates: null, identities: null };
					if (profiled)
						writeFileSync(
							join(
								destination,
								"private",
								id + ".profile-identities.json",
							),
							JSON.stringify({
								profilerSettings,
								profileIdentities,
							}),
							{ mode: 0o600 },
						);
					const after = identity(repo);
					writeFileSync(
						join(destination, "private", `${id}.identities.json`),
						JSON.stringify({ before, after }),
						{ mode: 0o600 },
					);
					result = {
						phase,
						profiled,
						sqliteWorkerEnabled: candidateWorker && phase === "B",
						measurementKind: profiled
							? "profiled-diagnostic"
							: "unprofiled-timing",
						round,
						fixture: {
							count,
							shape,
							seasonShape: process.env.SEASON_SHAPE ?? "same",
						},
						success: code === 0 && !!record && before === after,
						exitCode: code,
						terminated: !!signal,
						memoryCapBytes: capped ? 2147483648 : null,
						swapBytes: capped ? 0 : null,
						telemetry: record ? publish(record) : {},
						http: record?.http,
					};
					// Numeric fixed-schema HTTP fields only; never copy an arbitrary result object.
					if (record?.http) result.http = publishHttp(record.http);
					if (profiled) {
						result.profiling = publishProfiling(record?.profiling);
						result.sampledProfiles = profileAggregates;
						result.profileCaptureComplete =
							profileAggregates.parseFailures === 0 &&
							profileAggregates.heap.length > 0 &&
							profileAggregates.cpu.length > 0;
						result.success &&= result.profileCaptureComplete;
					}
					if (record) {
						const key = JSON.stringify({ shape, round });
						const current = {
							semantic: record.membershipDigest,
							selection: record.membershipSelectionDigest,
							data: record.dataRowDigest,
							cache: record.cacheRowDigest,
						};
						if (phase === "A1") semantic.set(key, current);
						const expected = semantic.get(key);
						result.membershipsMatch =
							expected.semantic === current.semantic;
						result.selectionOrderMatch =
							expected.selection === current.selection;
						result.dataRowsMatch = expected.data === current.data;
						result.cacheRowsMatch =
							expected.cache === current.cache;
						result.success &&=
							result.membershipsMatch &&
							result.selectionOrderMatch &&
							result.dataRowsMatch &&
							result.cacheRowsMatch;
						writeFileSync(
							join(
								destination,
								"private",
								`${id}.correctness.json`,
							),
							JSON.stringify({ expected, current }),
							{ mode: 0o600 },
						);
					}
					const peak = stdout.match(/CGROUP_PEAK (\d+)/);
					if (peak) result.cgroupPeakBytes = Number(peak[1]);
					const events = stdout.match(
						/CGROUP_EVENTS ([\s\S]*?)CGROUP_CPU/,
					);
					if (events)
						result.cgroupEvents = Object.fromEntries(
							events[1]
								.trim()
								.split("\n")
								.filter((s) =>
									/^(low|high|max|oom|oom_kill|oom_group_kill|sock_throttled) \d+$/.test(
										s,
									),
								)
								.map((s) => {
									const [k, v] = s.split(" ");
									return [k, Number(v)];
								}),
						);
					const cpu = stdout.match(/CGROUP_CPU ([\s\S]*)$/);
					if (cpu)
						result.cgroupCpu = Object.fromEntries(
							cpu[1]
								.trim()
								.split("\n")
								.filter((s) =>
									/^(usage_usec|user_usec|system_usec|nr_periods|nr_throttled|throttled_usec|nr_bursts|burst_usec) \d+$/.test(
										s,
									),
								)
								.map((s) => {
									const [k, v] = s.split(" ");
									return [k, Number(v)];
								}),
						);
					appendFileSync(
						join(destination, "samples.jsonl"),
						JSON.stringify(result) + "\n",
					);
					if (!result.success)
						throw new Error(
							"Worker failure or source drift; failure capture retained",
						);
				} finally {
					fixture.child.kill();
					control.child.kill();
				}
			}
	writeFileSync(
		join(destination, "complete.json"),
		JSON.stringify({
			success: true,
			capped,
			rounds,
			fixtures: fixtures.length,
		}),
	);
} finally {
	unlinkSync(worker);
	releaseSlot?.();
}
