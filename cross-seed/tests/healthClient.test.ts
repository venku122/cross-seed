import { createServer } from "node:http";
import {
	mkdtemp,
	mkdir,
	readdir,
	readFile,
	stat,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
const root = await mkdtemp(join(tmpdir(), "health-client-"));
process.env.CONFIG_DIR = root;
const { db } = await import("../src/db.js");
const { getDefaultRuntimeConfig, createAppDirHierarchy } =
	await import("../src/configuration.js");
const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
const { initializeLogger } = await import("../src/logger.js");
const {
	setClientsForTesting,
	collectClientProblems,
	collectClientLinkingProblems,
} = await import("../src/clients/TorrentClient.js");
const { default: QBittorrent } = await import("../src/clients/QBittorrent.js");
const { default: Deluge } = await import("../src/clients/Deluge.js");
const { healthRouter } = await import("../src/trpc/routers/health.js");
const source = join(root, "source");
const links = join(root, "links");
const counts: Record<string, number> = {};
let savePath = source;
let version = "v5.1.0";
let status = 200;
let preferencesStatus = 200;
let catalogFailure = false;
let connected = true;
let sessionExpired = false;
const server = createServer(async (req, res) => {
	const url = req.url!;
	counts[url] = (counts[url] ?? 0) + 1;
	if (url === "/json") {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
			method: string;
		};
		counts[payload.method] = (counts[payload.method] ?? 0) + 1;
		if (payload.method === "auth.login") {
			res.setHeader("Set-Cookie", "SID=fixture");
			sessionExpired = false;
		}
		res.end(
			JSON.stringify({
				result:
					payload.method === "web.connected"
						? connected
						: payload.method === "core.get_enabled_plugins"
							? ["Label"]
							: true,
				error: sessionExpired
					? { code: 1, message: "session expired" }
					: null,
				id: 1,
			}),
		);
		return;
	}
	if (url !== "/api/v2/auth/login" && req.headers.cookie !== "SID=fixture") {
		res.statusCode = 403;
		res.end("Forbidden");
		return;
	}
	if (url === "/api/v2/auth/login") {
		res.setHeader("Set-Cookie", "SID=fixture");
		res.end("Ok.");
	} else if (url === "/api/v2/app/version") {
		res.statusCode = status;
		res.end(version);
	} else if (url === "/api/v2/app/preferences") {
		res.statusCode = preferencesStatus;
		res.end("{}");
	} else if (url === "/api/v2/torrents/createTags") res.end("");
	else if (url === "/api/v2/torrents/info") {
		if (catalogFailure) {
			res.statusCode = 500;
			res.end("[]");
		} else
			res.end(
				JSON.stringify([
					{
						hash: "a".repeat(40),
						name: "Fixture.S01E01.mkv",
						save_path: savePath,
						total_size: 7,
						tags: "",
						category: "",
						files: [{ name: "media.mkv", size: 7 }],
						trackers: [],
					},
				]),
			);
	} else res.end("{}");
});
let client: InstanceType<typeof QBittorrent>;
let address: string;
const caller = healthRouter.createCaller({
	user: { id: 1, username: "fixture" },
} as import("../src/trpc/index.js").Context);
describe.sequential("real health adapters and disposable linking", () => {
	beforeAll(async () => {
		createAppDirHierarchy();
		initializeLogger({ verbose: false });
		await db.migrate.latest();
		await mkdir(source);
		await mkdir(links);
		await mkdir(join(root, "cross-seeds"));
		await writeFile(join(source, "media.mkv"), "fixture");
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			torrentClients: [`qbittorrent:${address}`],
			torrentDir: undefined,
			dataDirs: [],
			linkDirs: [links],
		});
		client = new QBittorrent(address, "fixture", 0, false);
		setClientsForTesting([client]);
		await client.validateConfig();
	});
	afterAll(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});
	it("retains qB validation outcomes without creating tags or logging in on each status sample", async () => {
		const logins = counts["/api/v2/auth/login"];
		const tags = counts["/api/v2/torrents/createTags"];
		expect(await collectClientProblems()).toEqual([]);
		expect(await collectClientProblems()).toEqual([]);
		expect(counts["/api/v2/auth/login"]).toBe(logins);
		expect(counts["/api/v2/torrents/createTags"]).toBe(tags);
		version = "4.2.0";
		expect(await collectClientProblems()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "client:validation:qbittorrent@fixture",
					severity: "error",
				}),
			]),
		);
		version = "v5.1.0";
		status = 500;
		expect(await collectClientProblems()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "client:validation:qbittorrent@fixture",
					severity: "error",
				}),
			]),
		);
		const freshClient = new QBittorrent(address, "fresh", 1, false);
		await expect(
			freshClient.validateConfig({ healthOnly: true }),
		).rejects.toThrow("failed with code 500");
		status = 200;
	}, 15_000);

	it("rejects a forbidden post-login version handshake and recovers on the same client", async () => {
		const cold = new QBittorrent(address, "forbidden-handshake", 1, false);
		status = 403;
		try {
			const result = await Promise.race([
				cold.validateConfig({ healthOnly: true }).then(
					() => "unexpected success",
					(error: Error) => error.message,
				),
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("handshake did not settle"), 1500),
				),
			]);
			expect(result).toContain("failed with code 403");
		} finally {
			status = 200;
		}
		// Another expired-cookie request must not join the permanently pending handshake.
		cold.cookie = "SID=expired";
		await cold.validateConfig({ healthOnly: true });
	});
	it("clears the shared router flight after a forbidden login handshake so refresh can recover", async () => {
		const cold = new QBittorrent(address, "router-handshake", 1, false);
		setClientsForTesting([cold]);
		status = 403;
		try {
			const failed = await caller.refresh();
			expect(failed.problems).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "client:validation:qbittorrent@router-handshake",
						severity: "error",
					}),
				]),
			);
			status = 200;
			const recovered = await caller.refresh();
			expect(
				recovered.problems.some((problem) =>
					problem.id.startsWith("client:validation:"),
				),
			).toBe(false);
		} finally {
			status = 200;
			setClientsForTesting([client]);
		}
	});
	it("reports failed preferences requests when validating torrentDir instead of accepting an empty error response", async () => {
		await writeFile(join(source, "fixture.fastresume"), "fixture");
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			torrentClients: [`qbittorrent:${address}`],
			torrentDir: source,
			dataDirs: [],
			linkDirs: [links],
		});
		preferencesStatus = 500;
		try {
			expect(await collectClientProblems()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "client:validation:qbittorrent@fixture",
						severity: "error",
					}),
				]),
			);
		} finally {
			preferencesStatus = 200;
			await rm(join(source, "fixture.fastresume"));
			setRuntimeConfig({
				...getDefaultRuntimeConfig(),
				torrentClients: [`qbittorrent:${address}`],
				torrentDir: undefined,
				dataDirs: [],
				linkDirs: [links],
			});
		}
	}, 15_000);
	it("shares cold authentication between status and save-path providers", async () => {
		const cold = new QBittorrent(address, "cold", 1, false);
		const before = counts["/api/v2/auth/login"];
		await Promise.all([
			cold.validateConfig({ healthOnly: true }),
			cold.getHealthSavePaths(),
		]);
		expect(counts["/api/v2/auth/login"]).toBe(before + 1);
		cold.cookie = "SID=expired";
		await Promise.all([
			cold.validateConfig({ healthOnly: true }),
			cold.getHealthSavePaths(),
		]);
		expect(counts["/api/v2/auth/login"]).toBe(before + 2);
	});
	it("reports linking diagnostics through the router and leaves no persistent probe files", async () => {
		const statements: string[] = [];
		const listener = (query: { sql: string }) => {
			statements.push(query.sql);
		};
		db.on("query", listener);
		const snapshot = await caller.refresh();
		db.off("query", listener);
		expect(
			statements.filter((sql) => sql.includes("client_searchee")),
		).toEqual([]);
		expect(
			snapshot.problems.filter((problem) =>
				problem.id.startsWith("client:linking"),
			),
		).toEqual([]);
		expect(await readdir(source)).toEqual(["media.mkv"]);
		expect(await readFile(join(source, "media.mkv"), "utf8")).toBe(
			"fixture",
		);
		expect((await stat(join(source, "media.mkv"))).nlink).toBe(1);
		expect(await readdir(links)).toEqual([]);
		expect(await readdir(join(root, "cross-seeds"))).toEqual([]);
		const requests = counts["/api/v2/torrents/info"];
		await Promise.all(Array.from({ length: 10 }, () => caller.get()));
		expect(counts["/api/v2/torrents/info"]).toBe(requests);
		expect(await readdir(source)).toEqual(["media.mkv"]);
		expect(await readFile(join(source, "media.mkv"), "utf8")).toBe(
			"fixture",
		);
		expect((await stat(join(source, "media.mkv"))).nlink).toBe(1);
		expect(await readdir(links)).toEqual([]);
		expect(await readdir(join(root, "cross-seeds"))).toEqual([]);
	});

	it("invalidates the snapshot when a client metadata refresh discovers a moved save path", async () => {
		await caller.refresh();
		savePath = join(root, "missing-source");
		await client.getClientSearchees();
		const snapshot = await caller.get();
		expect(snapshot.problems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: `client:linking-test-failed:qbittorrent@fixture:${savePath}`,
					severity: "warning",
				}),
			]),
		);
		savePath = source;
		await client.getClientSearchees();
		await caller.refresh();
	});

	it("preserves cross-platform linking problem identity and severity", async () => {
		savePath =
			process.platform === "win32" ? "/downloads" : "Z:\\downloads";
		const problems = await collectClientLinkingProblems();
		expect(problems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: `client:linking-cross-platform:qbittorrent@fixture:${savePath}`,
					severity: "error",
				}),
			]),
		);
		savePath = source;
	});

	it("preserves real data-directory linking diagnostics and removes all temporary probes", async () => {
		const config = {
			...getDefaultRuntimeConfig(),
			torrentDir: undefined,
			dataDirs: [source],
			linkDirs: [links],
		};
		setRuntimeConfig(config);
		const { collectDataLinkingProblems } =
			await import("../src/problems/linking.js");
		expect(await collectDataLinkingProblems()).toEqual([]);
		expect(await readdir(source)).toEqual(["media.mkv"]);
		expect(await readFile(join(source, "media.mkv"), "utf8")).toBe(
			"fixture",
		);
		expect((await stat(join(source, "media.mkv"))).nlink).toBe(1);
		expect(await readdir(links)).toEqual([]);
		setRuntimeConfig({
			...config,
			torrentClients: [`qbittorrent:${address}`],
			dataDirs: [],
		});
	});
	it("reports unavailable save-path inspection rather than silently displaying clear linking status", async () => {
		catalogFailure = true;
		const problems = await collectClientLinkingProblems();
		expect(problems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "client:linking-inspection:qbittorrent@fixture",
					severity: "error",
				}),
			]),
		);
		catalogFailure = false;
	}, 15_000);
	it("does not delete a Deluge session or reconnect a disconnected daemon while collecting status", async () => {
		const deluge = new Deluge(
			`${address.replace("http://", "http://:fixture@")}/json`,
			"fixture",
			0,
			false,
		);
		await deluge.validateConfig({ healthOnly: true });
		expect(counts["core.get_enabled_plugins"]).toBe(1);
		expect(counts["auth.delete_session"] ?? 0).toBe(0);
		expect(counts["web.connect"] ?? 0).toBe(0);
		const logins = counts["auth.login"];
		await deluge.validateConfig({ healthOnly: true });
		expect(counts["auth.login"]).toBe(logins);
		expect(counts["core.get_enabled_plugins"]).toBe(2);
		sessionExpired = true;
		await deluge.validateConfig({ healthOnly: true });
		expect(counts["auth.login"]).toBe(logins + 1);
		connected = false;
		await expect(
			deluge.validateConfig({ healthOnly: true }),
		).rejects.toThrow("disconnected");
		expect(counts["web.connect"] ?? 0).toBe(0);
	});
});
