import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const [baseline, candidate, destination] = process.argv
	.slice(2)
	.map((path) => resolve(path));
const worker = join(
	dirname(fileURLToPath(import.meta.url)),
	"health-worker.mjs",
);
mkdirSync(destination, { recursive: true });
const scenarios = [
	{
		name: "one-tab-no-links",
		tabs: 1,
		paths: 0,
		torrents: 100,
		rows: 150000,
	},
	{
		name: "ten-tabs-no-links",
		tabs: 10,
		paths: 0,
		torrents: 100,
		rows: 150000,
	},
	{
		name: "ten-tabs-shared-paths",
		tabs: 10,
		paths: 2,
		torrents: 8194,
		rows: 150000,
	},
	{
		name: "ten-tabs-distinct-paths",
		tabs: 10,
		paths: 10,
		torrents: 1000,
		rows: 150000,
	},
	{
		name: "slow-client",
		tabs: 10,
		paths: 2,
		torrents: 100,
		rows: 150000,
		delay: 50,
	},
	{
		name: "failed-client",
		tabs: 10,
		paths: 0,
		torrents: 100,
		rows: 150000,
		fail: 1,
	},
];
const samples = [];
for (const scenario of scenarios) {
	for (let round = 0; round < 5; round++) {
		for (const [phase, repo] of [
			["A1", baseline],
			["B", candidate],
			["A2", baseline],
		]) {
			const id = `${scenario.name}-${round}-${phase}`;
			const run = spawnSync(process.execPath, [worker, repo], {
				encoding: "utf8",
				maxBuffer: 20 * 1024 * 1024,
				env: {
					...process.env,
					HEALTH_TABS: String(scenario.tabs),
					HEALTH_PATHS: String(scenario.paths),
					HEALTH_TORRENTS: String(scenario.torrents),
					HEALTH_DB_ROWS: String(scenario.rows),
					HEALTH_DELAY_MS: String(scenario.delay || 0),
					HEALTH_FAIL: String(scenario.fail || 0),
					HEALTH_ASSERT_COALESCING: phase === "B" ? "1" : "0",
				},
			});
			writeFileSync(
				join(destination, `${id}.log`),
				run.stdout + run.stderr,
			);
			if (run.status !== 0)
				throw new Error(
					`${id} exited ${run.status}; raw log preserved`,
				);
			const line = run.stdout
				.split("\n")
				.find((line) => line.startsWith("HEALTH_RESULT="));
			if (!line) throw new Error(`${id} omitted result`);
			const result = {
				id,
				round,
				phase,
				scenario: scenario.name,
				result: JSON.parse(line.slice("HEALTH_RESULT=".length)),
			};
			samples.push(result);
			writeFileSync(
				join(destination, "samples.json"),
				JSON.stringify(samples, null, 2),
			);
			console.log(
				id,
				result.result.wallMs.toFixed(2),
				"ms",
				"dbstat",
				result.result.metrics.dbstat,
			);
		}
	}
}
