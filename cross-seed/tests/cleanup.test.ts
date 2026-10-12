import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const fs: { check: (path: string) => Promise<void> } = vi.hoisted(() => ({
	check: () => Promise.resolve(),
}));
vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	access: (path: string) => fs.check(path),
}));

let env: typeof import("../src/db.js");
let configDir: string;
let setConfig: typeof import("../src/runtimeConfig.js").setRuntimeConfig;
let defaults: typeof import("../src/configuration.js").getDefaultRuntimeConfig;

const missing = (code = "ENOENT") => Object.assign(new Error(code), { code });

async function seed(paths: (string | null)[], memberships = 1) {
	for (let offset = 0; offset < paths.length; offset += 100) {
		const batch = paths.slice(offset, offset + 100);
		await env
			.db("data")
			.insert(
				batch.map((path) => ({ path, title: "Synthetic fixture" })),
			);
		for (let member = 0; member < memberships; member++) {
			await env.db("ensemble").insert(
				batch.map((path) => ({
					path,
					client_host: null,
					info_hash: null,
					ensemble: `alternate-${member}`,
					element: "1",
				})),
			);
		}
	}
}

describe.sequential("cleanup cached filesystem paths", () => {
	beforeAll(async () => {
		configDir = await mkdtemp(join(tmpdir(), "cross-seed-cleanup-"));
		process.env.CONFIG_DIR = configDir;
		env = await import("../src/db.js");
		(
			env.db.client as { connectionSettings: { filename: string } }
		).connectionSettings.filename = ":memory:";
		const { createAppDirHierarchy, getDefaultRuntimeConfig } =
			await import("../src/configuration.js");
		defaults = getDefaultRuntimeConfig;
		({ setRuntimeConfig: setConfig } =
			await import("../src/runtimeConfig.js"));
		createAppDirHierarchy();
		const { initializeLogger } = await import("../src/logger.js");
		initializeLogger({ verbose: false });
		await env.db.migrate.latest();
	});
	afterAll(async () => {
		await env.db.destroy();
		delete process.env.CONFIG_DIR;
		await rm(configDir, { recursive: true, force: true });
	});
	beforeEach(async () => {
		await env.db("data").del();
		await env.db("ensemble").del();
		fs.check = () => Promise.resolve();
		setConfig({
			...defaults(),
			dataDirs: ["/synthetic/root"],
			seasonFromEpisodes: 1,
			useClientTorrents: false,
		});
	});

	it("bounds filesystem concurrency and checks each shared path once", async () => {
		const paths = Array.from(
			{ length: 1100 },
			(_, i) => `/synthetic/root/${i}`,
		);
		await seed(paths, 5);
		let active = 0;
		let peak = 0;
		const checked: string[] = [];
		fs.check = async (path) => {
			if (path === "/synthetic/root") return;
			checked.push(path);
			peak = Math.max(peak, ++active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			active--;
		};
		await env.cleanupDB();
		expect(peak).toBeLessThanOrEqual(64);
		expect(checked.length).toBe(paths.length);
		expect(new Set(checked)).toEqual(new Set(paths));
		expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
			n: 5500,
		});
	});

	it("avoids artificial timer sleeps for a small cached library", async () => {
		await seed(["/synthetic/root/file"], 5);
		const timer = vi.spyOn(globalThis, "setTimeout");
		try {
			await env.cleanupDB();
			expect(
				timer.mock.calls.filter(
					([, milliseconds]) => milliseconds === 0,
				),
			).toHaveLength(0);
		} finally {
			timer.mockRestore();
		}
	});

	it.each([0, 1, 100, 1100])(
		"prunes all missing paths in %i-row fixtures",
		async (count) => {
			await seed(
				Array.from({ length: count }, (_, i) => `/synthetic/root/${i}`),
				5,
			);
			fs.check = (path) =>
				path === "/synthetic/root"
					? Promise.resolve()
					: Promise.reject(missing());
			await env.cleanupDB();
			expect(await env.db("data")).toEqual([]);
			expect(await env.db("ensemble")).toEqual([]);
		},
	);

	it.each(["EACCES", "EIO", "ESTALE", "ETIMEDOUT"])(
		"retains cached paths on transient %s errors",
		async (code) => {
			await seed(["/synthetic/root/unavailable"], 5);
			fs.check = (path) =>
				path === "/synthetic/root"
					? Promise.resolve()
					: Promise.reject(missing(code));
			await env.cleanupDB();
			expect(await env.db("data").count({ n: "*" }).first()).toEqual({
				n: 1,
			});
			expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
				n: 5,
			});
		},
	);

	it("prunes ENOTDIR paths but retains accessible alternate memberships", async () => {
		await seed(
			["/synthetic/root/not-directory", "/synthetic/root/kept"],
			5,
		);
		fs.check = (path) =>
			path.endsWith("not-directory")
				? Promise.reject(missing("ENOTDIR"))
				: Promise.resolve();
		await env.cleanupDB();
		expect(await env.db("data").select("path")).toEqual([
			{ path: "/synthetic/root/kept" },
		]);
		expect(await env.db("ensemble").pluck("ensemble")).toEqual([
			"alternate-0",
			"alternate-1",
			"alternate-2",
			"alternate-3",
			"alternate-4",
		]);
	});

	it.each([
		[false, false],
		[true, false],
		[false, true],
	])(
		"honors enabled source flags data=%s ensemble=%s",
		async (dataEnabled, ensembleEnabled) => {
			await seed(["/synthetic/root/file"], 5);
			setConfig({
				...defaults(),
				dataDirs: dataEnabled ? ["/synthetic/root"] : [],
				seasonFromEpisodes: ensembleEnabled ? 1 : undefined,
				useClientTorrents: false,
			});
			let calls = 0;
			fs.check = (path) => {
				if (path === "/synthetic/root") return Promise.resolve();
				calls++;
				return Promise.reject(missing());
			};
			await env.cleanupDB();
			const enabled = dataEnabled || ensembleEnabled;
			expect(calls).toBe(enabled ? 1 : 0);
			expect(await env.db("data").count({ n: "*" }).first()).toEqual({
				n: enabled ? 0 : 1,
			});
			expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
				n: enabled ? 0 : 5,
			});
		},
	);

	it("does not delete cached entries while a configured data root is missing", async () => {
		await seed(["/synthetic/root/file"], 5);
		fs.check = () => Promise.reject(missing());
		await env.cleanupDB();
		expect(await env.db("data").count({ n: "*" }).first()).toEqual({
			n: 1,
		});
		expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
			n: 5,
		});
	});

	it("continues snatch housekeeping after an unavailable root", async () => {
		await seed(["/synthetic/root/file"], 5);
		const { snatchHistory } = await import("../src/torrent.js");
		snatchHistory.set("expired-review-fixture", {
			initialFailureAt: Date.now() - 2 * 86_400_000,
			numFailures: 2,
		});
		fs.check = (path) =>
			Promise.reject(
				missing(path === "/synthetic/root" ? "EIO" : "ENOENT"),
			);
		try {
			await env.cleanupDB();
			expect(snatchHistory.has("expired-review-fixture")).toBe(false);
			expect(await env.db("data").count({ n: "*" }).first()).toEqual({
				n: 1,
			});
			expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
				n: 5,
			});
		} finally {
			snatchHistory.delete("expired-review-fixture");
		}
	});

	it("checks roots only once per page with missing paths", async () => {
		await seed(
			Array.from({ length: 1100 }, (_, i) => `/synthetic/root/${i}`),
			5,
		);
		let rootCalls = 0;
		fs.check = (path) => {
			if (path === "/synthetic/root") {
				rootCalls++;
				return Promise.resolve();
			}
			return Promise.reject(missing());
		};
		await env.cleanupDB();
		expect(rootCalls).toBe(3);
		expect(await env.db("data")).toEqual([]);
		expect(await env.db("ensemble")).toEqual([]);
	});

	it("avoids root probes when all cached paths are accessible", async () => {
		await seed(
			Array.from({ length: 1100 }, (_, i) => `/synthetic/root/${i}`),
			5,
		);
		let rootCalls = 0;
		fs.check = (path) => {
			if (path === "/synthetic/root") rootCalls++;
			return Promise.resolve();
		};
		await env.cleanupDB();
		expect(rootCalls).toBe(0);
		expect(await env.db("data").count({ n: "*" }).first()).toEqual({
			n: 1100,
		});
	});

	it("retains both roots' cached paths when any configured root is unavailable", async () => {
		await seed(["/synthetic/root/file", "/synthetic/other/file"], 5);
		setConfig({
			...defaults(),
			dataDirs: ["/synthetic/root", "/synthetic/other"],
			seasonFromEpisodes: 1,
			useClientTorrents: false,
		});
		fs.check = (path) =>
			path === "/synthetic/other"
				? Promise.resolve()
				: Promise.reject(missing());
		await env.cleanupDB();
		expect(await env.db("data").count({ n: "*" }).first()).toEqual({
			n: 2,
		});
		expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
			n: 10,
		});
	});

	it("stops pruning after a later root outage and still finishes housekeeping", async () => {
		await seed(
			Array.from(
				{ length: 600 },
				(_, i) => `/synthetic/root/${String(i).padStart(4, "0")}`,
			),
			5,
		);
		const { snatchHistory } = await import("../src/torrent.js");
		snatchHistory.set("later-outage-fixture", {
			initialFailureAt: Date.now() - 2 * 86_400_000,
			numFailures: 2,
		});
		let rootCalls = 0;
		fs.check = (path) => {
			if (path === "/synthetic/root" && ++rootCalls === 1)
				return Promise.resolve();
			return Promise.reject(missing());
		};
		try {
			await env.cleanupDB();
			expect(await env.db("data").count({ n: "*" }).first()).toEqual({
				n: 88,
			});
			expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
				n: 440,
			});
			expect(snatchHistory.has("later-outage-fixture")).toBe(false);
		} finally {
			snatchHistory.delete("later-outage-fixture");
		}
	});

	it("preserves null paths and uses SQLite ordering for unusual paths", async () => {
		const paths = [
			null,
			"",
			"/synthetic/root/Å",
			"/synthetic/root/😀",
			"/synthetic/root/Z",
			"/synthetic/root/a",
			"/synthetic/root/\u0001",
			...Array.from(
				{ length: 520 },
				(_, i) => `/synthetic/root/pad-${i}`,
			),
		];
		await seed(paths, 5);
		const checked: string[] = [];
		fs.check = (path) => {
			if (path === "/synthetic/root") return Promise.resolve();
			checked.push(path);
			return Promise.reject(missing());
		};
		await env.cleanupDB();
		expect(new Set(checked)).toEqual(
			new Set(paths.filter((p) => p !== null)),
		);
		expect(await env.db("data").select("path")).toEqual([{ path: null }]);
		expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
			n: 5,
		});
	});

	it("continues after watcher insertions and deletions without skipping cached pages", async () => {
		const paths = Array.from(
			{ length: 1100 },
			(_, i) => `/synthetic/root/${String(i).padStart(4, "0")}`,
		);
		await seed(paths);
		let changed = false;
		fs.check = async (path) => {
			if (path === "/synthetic/root") return;
			if (!changed) {
				changed = true;
				await seed([
					"/synthetic/root/0000-before",
					"/synthetic/root/zz-after",
				]);
				await env.db("data").where("path", paths[600]).del();
				await env.db("ensemble").where("path", paths[600]).del();
			}
			throw missing();
		};
		await env.cleanupDB();
		// Inserts behind the captured page cursor are deliberately deferred.
		expect(await env.db("data").select("path")).toEqual([
			{ path: "/synthetic/root/0000-before" },
		]);
		await env.cleanupDB();
		expect(await env.db("data")).toEqual([]);
		expect(await env.db("ensemble")).toEqual([]);
	});

	it("rolls back both table deletions when a delete fails and can restart", async () => {
		await seed(["/synthetic/root/deleted"], 5);
		fs.check = (path) =>
			path === "/synthetic/root"
				? Promise.resolve()
				: Promise.reject(missing());
		await env.db.raw(
			"CREATE TRIGGER cleanup_failure BEFORE DELETE ON ensemble BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END",
		);
		try {
			await expect(env.cleanupDB()).rejects.toThrow(
				"synthetic delete failure",
			);
			expect(await env.db("data").count({ n: "*" }).first()).toEqual({
				n: 1,
			});
			expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
				n: 5,
			});
		} finally {
			await env.db.raw("DROP TRIGGER cleanup_failure");
		}
		await env.cleanupDB();
		expect(await env.db("data")).toEqual([]);
		expect(await env.db("ensemble")).toEqual([]);
	});

	it("retains a newly moved path and removes its missing old memberships", async () => {
		await seed(["/synthetic/root/old"], 5);
		fs.check = async (path) => {
			if (path !== "/synthetic/root/old") return;
			await seed(["/synthetic/root/new"], 5);
			throw missing();
		};
		await env.cleanupDB();
		expect(await env.db("data").select("path")).toEqual([
			{ path: "/synthetic/root/new" },
		]);
		expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
			n: 5,
		});
	});

	it.each([200_000, 1_000_000])(
		"prunes %i ensemble rows with five memberships per path",
		async (rows) => {
			const paths = rows / 5;
			await env.db.raw(
				"WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM numbers WHERE n+1 < ?) INSERT INTO data(path,title) SELECT '/synthetic/root/' || printf('%09d', n), 'Synthetic fixture' FROM numbers",
				[paths],
			);
			for (let member = 0; member < 5; member++) {
				await env.db.raw(
					"INSERT INTO ensemble(client_host,path,info_hash,ensemble,element) SELECT NULL,path,NULL,?, '1' FROM data",
					[`alternate-${member}`],
				);
			}
			let calls = 0;
			fs.check = (path) => {
				if (path === "/synthetic/root") return Promise.resolve();
				calls++;
				return Number(path.split("/").at(-1)) % 17 === 0
					? Promise.reject(missing())
					: Promise.resolve();
			};
			await env.cleanupDB();
			const remaining = paths - Math.ceil(paths / 17);
			expect(calls).toBe(paths);
			expect(await env.db("data").count({ n: "*" }).first()).toEqual({
				n: remaining,
			});
			expect(await env.db("ensemble").count({ n: "*" }).first()).toEqual({
				n: remaining * 5,
			});
			expect(await env.db.raw("PRAGMA integrity_check")).toEqual([
				{ integrity_check: "ok" },
			]);
		},
		60_000,
	);
});
