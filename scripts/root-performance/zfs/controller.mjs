// External controller/load generator: never part of daemon memory/CPU attribution.
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { collectPrivateProfiles } from "../profiling.mjs";
import { publish, publishHttp, publishProfiling } from "../privacy.mjs";
const id = process.env.RUN_ID ?? "review-run";
if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid run id");
const output = join("/results", id);
if (existsSync(output)) throw new Error("Fresh controller run id required");
mkdirSync(output, { mode: 0o700 });
mkdirSync(join(output, "private"), { mode: 0o700 });
let generator,
	windowResult,
	complete = false;
const timeout = setTimeout(
	() => {
		if (complete) return;
		generator?.kill();
		writeFileSync(
			join(output, "aggregate.json"),
			JSON.stringify({ success: false, controllerTimeout: true }),
		);
	},
	Number(process.env.RUN_TIMEOUT_MS ?? 180000),
);
const readCgroup = () => {
	const directory = join(output, "private");
	const result = {};
	try {
		const peak = readFileSync(
			join(directory, "memory.peak"),
			"utf8",
		).trim();
		if (/^\d+$/.test(peak)) result.memoryPeakBytes = Number(peak);
	} catch {}
	for (const [file, keys] of [
		[
			"memory.events",
			[
				"low",
				"high",
				"max",
				"oom",
				"oom_kill",
				"oom_group_kill",
				"sock_throttled",
			],
		],
		[
			"cpu.stat",
			[
				"usage_usec",
				"user_usec",
				"system_usec",
				"nr_periods",
				"nr_throttled",
				"throttled_usec",
				"nr_bursts",
				"burst_usec",
			],
		],
	]) {
		try {
			result[file === "memory.events" ? "events" : "cpu"] =
				Object.fromEntries(
					readFileSync(join(directory, file), "utf8")
						.trim()
						.split("\n")
						.map((line) => line.split(" "))
						.filter(
							([key, value]) =>
								keys.includes(key) && /^\d+$/.test(value),
						)
						.map(([key, value]) => [key, Number(value)]),
				);
		} catch {}
	}
	return result;
};
async function appendCgroup(aggregate) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const cgroup = readCgroup();
		if (
			cgroup.memoryPeakBytes !== undefined &&
			Object.keys(cgroup.events ?? {}).length &&
			Object.keys(cgroup.cpu ?? {}).length
		) {
			aggregate.cgroup = cgroup;
			if (aggregate.profiled) {
				try {
					const { aggregates, identities } =
						await collectPrivateProfiles(
							join(output, "private", "profiles"),
						);
					for (const profile of [
						...aggregates.heap,
						...aggregates.cpu,
					])
						profile.scope = "isolate-unclassified";
					aggregate.sampledProfiles = aggregates;
					aggregate.success &&=
						aggregates.parseFailures === 0 &&
						aggregates.heap.length > 0 &&
						aggregates.cpu.length > 0;
					writeFileSync(
						join(output, "private", "profile-identities.json"),
						JSON.stringify(identities),
						{ mode: 0o600 },
					);
				} catch {
					aggregate.profileCaptureUnavailable = true;
					aggregate.success = false;
				}
			}
			writeFileSync(
				join(output, "aggregate.json"),
				JSON.stringify(aggregate),
			);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	aggregate.cgroupCaptureUnavailable = true;
	aggregate.success = false;
	writeFileSync(join(output, "aggregate.json"), JSON.stringify(aggregate));
}
const server = createServer(async (req, res) => {
	try {
		let body = "";
		for await (const chunk of req) body += chunk;
		if (req.url === "/bench/ready") {
			res.end("ready");
			return;
		}
		if (req.url === "/worker-ready" && !generator) {
			generator = fork(
				new URL("./loadgen-warm.mjs", import.meta.url),
				[
					"http://daemon:4040/api/ping",
					String(process.env.PING_RATE ?? 200),
					String(process.env.PING_TIMEOUT ?? 2000),
				],
				{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
			);
			await once(generator, "message");
			const begun = once(generator, "message");
			generator.send({ type: "begin" });
			await begun;
			res.end("begin");
			return;
		}
		if (req.url === "/window-end" && generator && !windowResult) {
			const stopped = once(generator, "message");
			generator.send({ type: "stop" });
			[windowResult] = await stopped;
			generator.kill();
			res.end("stopped");
			return;
		}
		if (req.url === "/worker-finished" && windowResult && !complete) {
			const result = JSON.parse(body);
			const http = windowResult;
			writeFileSync(
				join(output, "private", "worker.json"),
				JSON.stringify(result),
				{ mode: 0o600 },
			);
			const aggregate = {
				failedClientRefreshes:
					typeof result.failedClientRefreshes === "number"
						? result.failedClientRefreshes
						: 0,
				operations:
					typeof result.operations === "number"
						? result.operations
						: 1,
				rpcReplayDelayMs:
					typeof result.rpcReplayDelayMs === "number"
						? result.rpcReplayDelayMs
						: 0,
				success: result.success === true,
				profiled: result.profiled === true,
				telemetry: publish(result),
				profiling: publishProfiling(result.profiling),
				http: publishHttp(http),
			};
			try {
				const stats = await (
					await fetch("http://fixture:4041/bench/stats")
				).json();
				aggregate.rpc = Object.fromEntries(
					[
						"requests",
						"decodedBytes",
						"blockedRequests",
						"infoRequests",
					]
						.filter((key) => typeof stats[key] === "number")
						.map((key) => [key, stats[key]]),
				);
				aggregate.success &&= stats.blockedRequests === 0;
			} catch {
				aggregate.success = false;
				aggregate.rpcStatsUnavailable = true;
			}
			writeFileSync(
				join(output, "aggregate.json"),
				JSON.stringify(aggregate),
			);
			complete = true;
			clearTimeout(timeout);
			res.end("recorded");
			void appendCgroup(aggregate);
			return;
		}
		res.statusCode = 409;
		res.end("unsupported");
	} catch (error) {
		writeFileSync(
			join(output, "private", "controller-error.txt"),
			String(error.stack ?? error),
			{ mode: 0o600 },
		);
		res.statusCode = 500;
		res.end("controller failure");
	}
});
server.listen(4042, "0.0.0.0");
