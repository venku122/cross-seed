import type { ClientSearcheeRow, SearcheeLabel } from "../src/searchee.js";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
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

const config = await mkdtemp(join(tmpdir(), "qb-targeted-test-"));
process.env.CONFIG_DIR = config;
const { db } = await import("../src/db.js");
const logging = await import("../src/logger.js");
logging.initializeLogger({ verbose: false });
logging.logger.silent = true;
const { default: QBittorrent } = await import("../src/clients/QBittorrent.js");
const hash = "1".repeat(40);
const alias = "2".repeat(64);
const info = {
	hash,
	infohash_v1: hash,
	infohash_v2: alias,
	name: "Fixture",
	save_path: "/fixture/moved",
	category: "new",
	tags: "new, second",
	total_size: 100,
	state: "downloading",
};
let responseGate: ((params: URLSearchParams) => Promise<void>) | undefined;
let catalogExtras: (typeof info)[] = [];
let present = true;
let failFiles = false;
let failInfo = false;
let failTrackers = false;
let transientFailures = 0;
let authFailure = false;
let embedded = false;
let identityKind: "hybrid" | "legacy" | "v2" = "hybrid";
let failCatalog = false;
let catalogDelay = 0;
let requests: { route: string; hashes: string | null }[] = [];
const server = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const params = new URLSearchParams(body);
	const endpoint = req.url!.startsWith("/first/")
		? "first"
		: req.url!.startsWith("/second/")
			? "second"
			: undefined;
	const route = req.url!.replace(/^.*?\/api\/v2/, "");
	requests.push({ route, hashes: params.get("hashes") });
	if (authFailure) {
		res.statusCode = route === "/auth/login" ? 401 : 403;
		res.end("denied");
		return;
	}
	if (route === "/torrents/info" && transientFailures-- > 0) {
		res.statusCode = 503;
		res.end("retry");
		return;
	}
	if (route === "/torrents/info" && !params.has("hashes")) {
		if (catalogDelay)
			await new Promise((resolve) => setTimeout(resolve, catalogDelay));
		if (failCatalog) {
			res.statusCode = 400;
			res.end("catalog unavailable");
			return;
		}
	}
	if (failInfo && route === "/torrents/info") {
		res.statusCode = 400;
		res.end("unavailable");
		return;
	}
	if (failTrackers && route === "/torrents/trackers") {
		res.statusCode = 404;
		res.end("deleted");
		return;
	}
	if (failFiles && route === "/torrents/files") {
		res.statusCode = 404;
		res.end("deleted");
		return;
	}

	const torrentRows = [info, ...catalogExtras]
		.filter(
			(torrent) =>
				!params.has("hashes") || params.get("hashes") === torrent.hash,
		)
		.map((torrent) => ({
			...torrent,
			...(identityKind === "legacy"
				? { infohash_v1: undefined, infohash_v2: undefined }
				: identityKind === "v2"
					? { infohash_v1: "" }
					: {}),
			...(embedded
				? {
						files: [
							{
								name: endpoint
									? `${endpoint}.mkv`
									: "embedded.mkv",
								size: 100,
								index: 0,
								progress: 1,
								priority: 1,
							},
						],
						trackers: endpoint
							? [
									{
										url: `https://${endpoint}.invalid/announce`,
										tier: 0,
										status: 2,
									},
								]
							: [],
					}
				: {}),
		}));
	const value =
		route === "/torrents/info"
			? present
				? torrentRows
				: []
			: route === "/torrents/files"
				? [
						{
							name: "renamed.mkv",
							size: 100,
							progress: 1,
							index: 0,
							priority: 1,
						},
					]
				: [
						{
							url: "https://fixture.invalid/announce",
							tier: 0,
							status: 2,
						},
					];

	const payload = JSON.stringify(value);
	if (route === "/torrents/info") await responseGate?.(params);
	res.setHeader("content-type", "application/json");
	res.end(payload);
});
let client: InstanceType<typeof QBittorrent>;
let fixtureOwner: string;
beforeAll(async () => {
	await db.migrate.latest();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const address = server.address() as import("node:net").AddressInfo;
	client = new QBittorrent(
		`http://127.0.0.1:${address.port}`,
		"fixture",
		0,
		true,
	);
});
beforeEach(async () => {
	requests = [];
	catalogExtras = [];
	info.hash = hash;
	responseGate = undefined;
	present = true;
	failFiles = false;
	failInfo = false;
	failTrackers = false;
	transientFailures = 0;
	authFailure = false;
	embedded = false;
	identityKind = "hybrid";
	failCatalog = false;
	catalogDelay = 0;
	info.state = "downloading";
	const { ensureSourceNamespace } = await import("../src/sourceStore.js");
	const address = server.address() as import("node:net").AddressInfo;
	const owner = await ensureSourceNamespace(
		db,
		"client",
		`http://127.0.0.1:${address.port}`,
	);
	fixtureOwner = owner;
	await db<ClientSearcheeRow>("client_searchee").del();
	await db<ClientSearcheeRow>("client_searchee").insert({
		client_host: "fixture",
		source_namespace_id: owner,
		info_hash: hash,
		name: "old",
		title: "old",
		files: "[]",
		length: 0,
		save_path: "/old",
		category: "old",
		tags: "[]",
		trackers: "[]",
	});
	await db<ClientSearcheeRow>("client_searchee").insert({
		client_host: "other",
		info_hash: hash,
		name: "other",
		title: "other",
		files: "[]",
		length: 0,
		save_path: "/other",
		category: "",
		tags: "[]",
		trackers: "[]",
	});
});
afterAll(async () => {
	await db.destroy();
	await new Promise<void>((r) => server.close(() => r()));
	await rm(config, { recursive: true, force: true });
});
function gate() {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { pending, release };
}

describe("qB request ordered publication", () => {
	it("rehydrates identical shallow fields across endpoint A to B to A without borrowing file metadata", async () => {
		const { restartClientCachePublication } =
			await import("../src/clientCachePublication.js");
		const address = server.address() as import("node:net").AddressInfo;
		const base = `http://127.0.0.1:${address.port}`;
		const firstUrl = `${base}/first`,
			secondUrl = `${base}/second`;
		embedded = true;
		const first = new QBittorrent(firstUrl, "endpoint-cache", 0, true);
		expect(
			(await first.getClientSearchees()).searchees[0]?.files[0]?.name,
		).toBe("first.mkv");
		await db("source_namespace")
			.where({ type: "client", locator: firstUrl })
			.update({ enabled: 0 });
		restartClientCachePublication();
		const second = new QBittorrent(secondUrl, "endpoint-cache", 0, true);
		const changed = await second.getClientSearchees();
		expect(changed.newSearchees[0]?.files[0]?.name).toBe("second.mkv");
		expect(changed.newSearchees[0]?.trackers).toEqual(["second.invalid"]);
		await db("source_namespace")
			.where({ type: "client", locator: secondUrl })
			.update({ enabled: 0 });
		await db("source_namespace")
			.where({ type: "client", locator: firstUrl })
			.update({ enabled: 1 });
		restartClientCachePublication();
		const rebound = new QBittorrent(firstUrl, "endpoint-cache", 0, true);
		const returned = await rebound.getClientSearchees();
		expect(returned.newSearchees[0]?.files[0]?.name).toBe("first.mkv");
		expect(returned.newSearchees[0]?.trackers).toEqual(["first.invalid"]);
		const row = await db<ClientSearcheeRow>("client_searchee")
			.where({ client_host: "endpoint-cache", info_hash: hash })
			.first();
		expect(
			(
				await db<{ locator: string }>("source_namespace")
					.where("id", row!.source_namespace_id!)
					.first()
			)?.locator,
		).toBe(firstUrl);
		expect(
			await db("source_namespace")
				.where({ locator: secondUrl, enabled: 0 })
				.first(),
		).toBeDefined();
	});

	it("retries an unchanged cache-hit catalog superseded after actual cache hydration", async () => {
		embedded = true;
		info.save_path = "/fixture/cache-old";
		await client.refreshOne(hash);
		const cache = await import("../src/clients/clientCache.js");
		const original = cache.cachedClientTorrents;
		const entered = gate(),
			held = gate();
		let blocked = false;
		const observer = vi
			.spyOn(cache, "cachedClientTorrents")
			.mockImplementation(async function* (...args) {
				for await (const entry of original(...args)) {
					yield entry;
					if (entry.useCache && !blocked) {
						blocked = true;
						entered.release();
						await held.pending;
					}
				}
			});
		try {
			const old = client.getClientSearchees();
			await entered.pending;
			info.save_path = "/fixture/cache-new";
			await client.refreshOne(hash);
			held.release();
			expect((await old).searchees[0]?.savePath).toBe(
				"/fixture/cache-new",
			);
		} finally {
			held.release();
			observer.mockRestore();
		}
	});

	it("does not relabel a shared old empty catalog as a later scoped not-found result", async () => {
		const canonical = "3".repeat(40);
		const secondAlias = "4".repeat(64);
		const second = {
			...info,
			hash: canonical,
			infohash_v1: canonical,
			infohash_v2: secondAlias,
		};
		catalogExtras = [second];
		embedded = true;
		present = false;
		const entered = gate(),
			held = gate(),
			joined = gate();
		let blocked = false;
		responseGate = async (params) => {
			if (!params.has("hashes") && !blocked) {
				blocked = true;
				entered.release();
				await held.pending;
			}
		};
		const transport = client as unknown as {
			metadataRequest: (
				route: string,
				params: URLSearchParams,
			) => Promise<unknown>;
		};
		const original = transport.metadataRequest.bind(
			client,
		) as typeof transport.metadataRequest;
		const observer = vi
			.spyOn(transport, "metadataRequest")
			.mockImplementation(async (route, params) => {
				const value = await original(route, params);
				if (
					params.get("hashes") === secondAlias &&
					Array.isArray(value) &&
					!value.length
				)
					queueMicrotask(() =>
						queueMicrotask(() => joined.release()),
					);
				return value;
			});
		try {
			const first = client.refreshOne(alias);
			await entered.pending;
			present = true;
			info.save_path = "/fixture/appeared";
			second.save_path = info.save_path;
			await client.refreshOne(canonical);
			const later = client.refreshOne(secondAlias);
			await joined.pending;
			held.release();
			expect((await later)?.savePath).toBe("/fixture/appeared");
			// The unrelated first source has no newer accepted publication; its
			// earlier negative observation remains valid under the read-order contract.
			expect(await first).toBeUndefined();
		} finally {
			held.release();
			observer.mockRestore();
		}
	});

	it("never publishes a shared older embedded alias catalog under a later consumer lease", async () => {
		const canonical = "3".repeat(40);
		const secondAlias = "4".repeat(64);
		const second = {
			...info,
			hash: canonical,
			infohash_v1: canonical,
			infohash_v2: secondAlias,
		};
		catalogExtras = [second];
		embedded = true;
		info.save_path = "/fixture/shared-old";
		second.save_path = info.save_path;
		const entered = gate(),
			held = gate(),
			joined = gate();
		let blocked = false;
		responseGate = async (params) => {
			if (!params.has("hashes") && !blocked) {
				blocked = true;
				entered.release();
				await held.pending;
			}
		};
		const transport = client as unknown as {
			metadataRequest: (
				route: string,
				params: URLSearchParams,
			) => Promise<unknown>;
		};
		const original = transport.metadataRequest.bind(
			client,
		) as typeof transport.metadataRequest;
		const observer = vi
			.spyOn(transport, "metadataRequest")
			.mockImplementation(async (route, params) => {
				const value = await original(route, params);
				if (
					params.get("hashes") === secondAlias &&
					Array.isArray(value) &&
					!value.length
				) {
					// Let the real caller consume its targeted miss and join the held catalog
					// before releasing that response. No RPC data is replaced by this observer.
					queueMicrotask(() =>
						queueMicrotask(() => joined.release()),
					);
				}
				return value;
			});
		try {
			const first = client.refreshOne(alias);
			await entered.pending;
			info.save_path = "/fixture/shared-new";
			second.save_path = info.save_path;
			expect((await client.refreshOne(canonical))?.savePath).toBe(
				"/fixture/shared-new",
			);
			const later = client.refreshOne(secondAlias);
			await joined.pending;
			held.release();
			expect((await later)?.savePath).toBe("/fixture/shared-new");
			expect((await first)?.savePath).toBe("/fixture/shared-new");
			expect(
				requests.filter(
					(request) =>
						request.route === "/torrents/info" &&
						request.hashes === null,
				),
			).toHaveLength(1);
		} finally {
			held.release();
			observer.mockRestore();
		}
	});

	it("rejects retrying a retained old client instance after an endpoint rebind", async () => {
		const { restartClientCachePublication } =
			await import("../src/clientCachePublication.js");
		const address = server.address() as import("node:net").AddressInfo;
		const oldClient = new QBittorrent(
			`http://127.0.0.1:${address.port}`,
			"retained-client",
			0,
			true,
		);
		const entered = gate(),
			held = gate();
		let blocked = false;
		responseGate = async (params) => {
			if (params.has("hashes") && !blocked) {
				blocked = true;
				entered.release();
				await held.pending;
			}
		};
		const pending = oldClient.refreshOne(hash);
		const rejected = expect(pending).rejects.toThrow(
			"configuration changed",
		);
		await entered.pending;
		restartClientCachePublication();
		new QBittorrent(
			"https://replacement.invalid/rpc",
			"retained-client",
			0,
			true,
		);
		held.release();
		await rejected;
		expect(
			await db("client_searchee").where("client_host", "retained-client"),
		).toHaveLength(0);
	});

	it("reconciles a successfully validated empty complete inventory", async () => {
		present = false;
		expect(await client.getClientSearchees({ refresh: [] })).toEqual({
			searchees: [],
			newSearchees: [],
		});
		expect(
			await db("client_searchee").where("client_host", "fixture"),
		).toHaveLength(0);
		expect(
			await db("client_searchee").where("client_host", "other"),
		).toHaveLength(1);
	});

	it("retries complete catalogs changed remotely during separate detail hydration", async () => {
		info.save_path = "/fixture/full-old";
		let changed = false;
		responseGate = (params) => {
			if (!params.has("hashes") && !changed) {
				changed = true;
				info.save_path = "/fixture/full-new";
			}
			return Promise.resolve();
		};
		const result = await client.getClientSearchees({ refresh: [] });
		expect(result.newSearchees[0]?.savePath).toBe("/fixture/full-new");
		expect(
			(
				await db<ClientSearcheeRow>("client_searchee")
					.where({ client_host: "fixture", info_hash: hash })
					.first()
			)?.save_path,
		).toBe("/fixture/full-new");
	});
	it("preserves cache and absent sources when full catalog fingerprints never stabilize", async () => {
		await db("client_searchee").insert({
			client_host: "fixture",
			info_hash: "absent",
			name: "preserve",
			files: "[]",
		});
		let catalogs = 0;
		responseGate = (params) => {
			if (!params.has("hashes"))
				info.save_path = `/fixture/drift-${++catalogs}`;
			return Promise.resolve();
		};
		await expect(
			client.getClientSearchees({ refresh: [] }),
		).rejects.toThrow("concurrency retries exhausted");
		expect(catalogs).toBe(3);
		expect(
			(
				await db<ClientSearcheeRow>("client_searchee")
					.where({ client_host: "fixture", info_hash: hash })
					.first()
			)?.save_path,
		).toBe("/old");
		expect(
			await db("client_searchee")
				.where({ client_host: "fixture", info_hash: "absent" })
				.first(),
		).toBeDefined();
	});
	it("uses one embedded complete catalog without redundant fingerprint RPCs", async () => {
		embedded = true;
		await client.getClientSearchees({
			refresh: [],
			includeFiles: true,
			includeTrackers: true,
		});
		expect(
			requests.filter((request) => request.route === "/torrents/info"),
		).toHaveLength(1);
	});

	it("revalidates placement changed remotely between info and separate detail requests", async () => {
		info.save_path = "/fixture/remote-old";
		let moved = false;
		responseGate = (params) => {
			if (params.has("hashes") && !moved) {
				moved = true;
				info.save_path = "/fixture/remote-new";
			}
			return Promise.resolve();
		};
		expect((await client.refreshOne(hash))?.savePath).toBe(
			"/fixture/remote-new",
		);
	});

	it("retries a superseded absent scoped response instead of reporting not found", async () => {
		present = false;
		let changed = false;
		responseGate = async (params) => {
			if (
				!params.has("hashes") &&
				!params.has("includeFiles") &&
				!changed
			) {
				changed = true;
				present = true;
				await client.getClientSearchees({
					refresh: [],
					includeFiles: true,
					includeTrackers: true,
				});
			}
		};
		expect((await client.refreshOne(hash))?.infoHash).toBe(hash);
	});

	it("reports concurrency after bounded scoped retries lose to newer HTTP snapshots", async () => {
		embedded = true;
		let scopes = 0;
		responseGate = async (params) => {
			if (params.has("hashes")) {
				scopes++;
				await client.getClientSearchees({
					refresh: [],
					includeFiles: true,
					includeTrackers: true,
				});
			}
		};
		await expect(client.refreshOne(hash)).rejects.toThrow(
			"concurrency retries exhausted",
		);
		expect(scopes).toBe(3);
	});

	it("preserves absent cached sources when complete detail hydration fails", async () => {
		await db("client_searchee").insert({
			client_host: "fixture",
			info_hash: "absent",
			name: "preserve",
			files: "[]",
		});
		failFiles = true;
		await expect(
			client.getClientSearchees({ refresh: [] }),
		).rejects.toThrow("incomplete");
		expect(
			await db<ClientSearcheeRow>("client_searchee")
				.where({ client_host: "fixture", info_hash: "absent" })
				.first(),
		).toBeDefined();
	});

	it("keeps the scoped move when an older complete HTTP snapshot finishes last", async () => {
		const entered = gate(),
			held = gate();
		info.save_path = "/fixture/old";
		responseGate = async (params) => {
			if (!params.has("hashes")) {
				entered.release();
				await held.pending;
			}
		};
		const full = client.getClientSearchees({
			refresh: [],
			includeFiles: true,
			includeTrackers: true,
		});
		await entered.pending;
		info.save_path = "/fixture/new";
		await client.refreshOne(hash);
		held.release();
		await full;
		expect(
			(await db<ClientSearcheeRow>("client_searchee")
				.where({ client_host: "fixture", info_hash: hash })
				.first())!.save_path,
		).toBe("/fixture/new");
	});
	it("retries an older scoped HTTP response after a newer complete snapshot commits", async () => {
		const entered = gate(),
			held = gate();
		info.save_path = "/fixture/old";
		let blocked = false;
		responseGate = async (params) => {
			if (params.has("hashes") && !blocked) {
				blocked = true;
				entered.release();
				await held.pending;
			}
		};
		const scoped = client.refreshOne(hash);
		await entered.pending;
		info.save_path = "/fixture/new";
		await client.getClientSearchees({
			refresh: [],
			includeFiles: true,
			includeTrackers: true,
		});
		held.release();
		expect((await scoped)?.savePath).toBe("/fixture/new");
		expect(
			(await db<ClientSearcheeRow>("client_searchee")
				.where({ client_host: "fixture", info_hash: hash })
				.first())!.save_path,
		).toBe("/fixture/new");
	});
});

describe("qB scoped refresh", () => {
	it("refreshes legacy primary-only hashes without a catalog fallback", async () => {
		identityKind = "legacy";
		expect((await client.refreshOne(hash.toUpperCase()))?.infoHash).toBe(
			hash,
		);
		expect(
			requests.filter(
				(r) => r.route === "/torrents/info" && r.hashes === null,
			),
		).toHaveLength(0);
	});
	it("resolves pure-v2 identities while preserving the primary cache key", async () => {
		identityKind = "v2";
		expect((await client.refreshOne(alias))?.infoHash).toBe(hash);
		expect(
			await db<ClientSearcheeRow>("client_searchee")
				.where("client_host", "fixture")
				.select("info_hash"),
		).toEqual([{ info_hash: hash }]);
	});
	it("coalesces distinct alias misses while a slow catalog request is pending", async () => {
		// Model network latency to hold the shared catalog flight open.
		catalogDelay = 50;
		const [found, absent] = await Promise.all([
			client.refreshOne(alias),
			client.refreshOne("3".repeat(64)),
		]);
		expect(found?.infoHash).toBe(hash);
		expect(absent).toBeUndefined();
		expect(
			requests.filter(
				(r) => r.route === "/torrents/info" && r.hashes === null,
			),
		).toHaveLength(1);
	});
	it("clears a rejected alias catalog flight so later refreshes can retry", async () => {
		failCatalog = true;
		await expect(client.refreshOne(alias)).rejects.toThrow();
		expect(
			(await db<{ name: string }>("client_searchee")
				.where("client_host", "fixture")
				.first())!.name,
		).toBe("old");
		failCatalog = false;
		expect((await client.refreshOne(alias))?.infoHash).toBe(hash);
		expect(
			requests.filter(
				(r) => r.route === "/torrents/info" && r.hashes === null,
			),
		).toHaveLength(2);
	});

	it("updates mutable target metadata and preserves other clients", async () => {
		const refreshed = await client.refreshOne(hash);
		expect(refreshed).toMatchObject({
			infoHash: hash,
			savePath: info.save_path,
			category: "new",
			tags: ["new", "second"],
			files: [{ name: "renamed.mkv", path: "renamed.mkv", length: 100 }],
			trackers: ["fixture.invalid"],
		});
		expect(
			(
				await db<ClientSearcheeRow>("client_searchee")
					.where("client_host", "other")
					.first()
			)?.name,
		).toBe("other");
		expect(
			requests
				.filter((r) => r.route === "/torrents/info")
				.every((r) => r.hashes === hash),
		).toBe(true);
	});
	it("binds authoritative hybrid aliases to a single source origin", async () => {
		await client.refreshOne(alias);
		const bound = await db<{ origin_id: string; alias: string }>(
			"source_alias",
		)
			.where("namespace_id", fixtureOwner)
			.whereIn("alias", [hash, alias])
			.select("origin_id", "alias");
		expect(bound.some((row) => row.alias === hash)).toBe(true);
		expect(bound.some((row) => row.alias === alias)).toBe(true);
		expect(new Set(bound.map((row) => row.origin_id)).size).toBe(1);
	});
	it("resolves hybrid aliases with one bounded catalog fallback", async () => {
		expect((await client.refreshOne(alias.toUpperCase()))?.infoHash).toBe(
			hash,
		);
		expect(
			requests.filter(
				(r) => r.route === "/torrents/info" && r.hashes === null,
			),
		).toHaveLength(1);
	});
	it("returns absence without removing cached data", async () => {
		present = false;
		expect(await client.refreshOne(hash)).toBeUndefined();
		expect(
			await db<ClientSearcheeRow>("client_searchee")
				.count({ n: "*" })
				.first(),
		).toMatchObject({ n: 2 });
	});
	it("coalesces concurrent same-hash metadata requests", async () => {
		const results = await Promise.all(
			Array.from({ length: 10 }, () => client.refreshOne(hash)),
		);
		expect(results.every((r) => r?.infoHash === hash)).toBe(true);
		expect(
			requests.filter((r) => r.route === "/torrents/files"),
		).toHaveLength(1);
	});

	it("uses embedded target metadata when the client supports it", async () => {
		embedded = true;
		expect((await client.refreshOne(hash))?.files[0].path).toBe(
			"embedded.mkv",
		);
		expect(requests).toHaveLength(1);
	});
	it("rejects transport timeouts without treating them as absence", async () => {
		const realFetch = globalThis.fetch;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation((...args) => {
				const url =
					typeof args[0] === "string"
						? args[0]
						: args[0] instanceof URL
							? args[0].href
							: args[0].url;
				if (url.includes("/torrents/info"))
					return Promise.reject(
						new DOMException("fixture timeout", "TimeoutError"),
					);
				return realFetch(...args);
			});
		try {
			await expect(client.refreshOne(hash)).rejects.toThrow();
			expect(
				(
					await db<ClientSearcheeRow>("client_searchee")
						.where("client_host", "fixture")
						.first()
				)?.name,
			).toBe("old");
		} finally {
			fetchSpy.mockRestore();
		}
		expect((await client.refreshOne(hash))?.infoHash).toBe(hash);
	}, 20000);
	it("retries transient HTTP failure without changing other clients", async () => {
		transientFailures = 1;
		expect((await client.refreshOne(hash))?.infoHash).toBe(hash);
		expect(
			requests.filter((r) => r.route === "/torrents/info"),
		).toHaveLength(3);
	});
	it("rejects exhausted authentication failure and preserves cached metadata", async () => {
		authFailure = true;
		await expect(client.refreshOne(hash)).rejects.toThrow();
		expect(
			(
				await db<ClientSearcheeRow>("client_searchee")
					.where("client_host", "fixture")
					.first()
			)?.name,
		).toBe("old");
	}, 20000);
	it("does not turn API failure into confirmed absence or prune cache", async () => {
		failInfo = true;
		await expect(client.refreshOne(hash)).rejects.toThrow();
		expect(
			(
				await db<ClientSearcheeRow>("client_searchee")
					.where("client_host", "fixture")
					.first()
			)?.name,
		).toBe("old");
		expect(requests).toHaveLength(1);
	});
	it("rejects tracker disappearance without committing partial metadata", async () => {
		failTrackers = true;
		await expect(client.refreshOne(hash)).rejects.toThrow();
		expect(
			(
				await db<ClientSearcheeRow>("client_searchee")
					.where("client_host", "fixture")
					.first()
			)?.name,
		).toBe("old");
	});
	it("preserves cache and rejects a concurrent deletion during details", async () => {
		failFiles = true;
		await expect(client.refreshOne(hash)).rejects.toThrow();
		expect(
			(
				await db<ClientSearcheeRow>("client_searchee")
					.where("client_host", "fixture")
					.first()
			)?.name,
		).toBe("old");
		failFiles = false;
		expect((await client.refreshOne(hash))?.name).toBe(info.name);
	});
});

const { performActionWithoutMutex } = await import("../src/action.js");
const { setClientsForTesting, refreshClientSearchee } =
	await import("../src/clients/TorrentClient.js");
const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
const { getDefaultRuntimeConfig } = await import("../src/configuration.js");
const { Action, Decision, InjectionResult, LinkType } =
	await import("../src/constants.js");
const { Label } = await import("../src/logger.js");
const { Metafile } = await import("../src/parseTorrent.js");
const meta = new Metafile({
	info: {
		name: Buffer.from("Fixture.mkv"),
		length: 100,
		"piece length": 16384,
		pieces: Buffer.alloc(20),
		private: 1,
	},
});
async function actionSource(label: SearcheeLabel) {
	const root = join(config, "source");
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "old.mkv"), Buffer.alloc(100));
	setRuntimeConfig({
		...getDefaultRuntimeConfig(),
		action: Action.INJECT,
		linkDirs: [join(config, "links")],
		outputDir: config,
	});
	setClientsForTesting([client]);
	return {
		infoHash: hash,
		clientHost: "fixture",
		name: "old",
		title: "old",
		savePath: root,
		files: [{ name: "old.mkv", path: "old.mkv", length: 100 }],
		length: 100,
		label,
	};
}
describe("link source refresh routing", () => {
	it("refreshes the read-only source and injects only into a separate writable client", async () => {
		const source = await actionSource(Label.SEARCH);
		const moved = join(config, "multiple-client-source");
		const links = join(config, "multiple-client-links");
		await mkdir(moved, { recursive: true });
		await mkdir(links, { recursive: true });
		await writeFile(join(moved, "renamed.mkv"), Buffer.alloc(100));
		const oldPath = info.save_path;
		info.save_path = moved;
		info.state = "uploading";
		const address = server.address() as import("node:net").AddressInfo;
		const destination = new QBittorrent(
			`http://127.0.0.1:${address.port}`,
			"other",
			1,
			false,
		);
		setClientsForTesting([destination, client]);
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			action: Action.INJECT,
			linkDirs: [links],
			linkType: LinkType.HARDLINK,
			outputDir: config,
		});
		const candidate = new Metafile({
			info: {
				name: Buffer.from("renamed.mkv"),
				length: 100,
				"piece length": 16384,
				pieces: Buffer.alloc(20),
				private: 1,
			},
		});
		const sourceRefresh = vi.spyOn(client, "refreshOne");
		const destinationRefresh = vi.spyOn(destination, "refreshOne");
		const sourceInjection = vi.spyOn(client, "inject");
		const destinationInjection = vi
			.spyOn(destination, "inject")
			.mockResolvedValue(InjectionResult.SUCCESS);
		try {
			const result = await performActionWithoutMutex(
				candidate,
				Decision.MATCH,
				source,
				"fixture",
				destination,
				{ onlyCompleted: true },
			);
			expect(result.actionResult).toBe(InjectionResult.SUCCESS);
			expect(sourceRefresh).toHaveBeenCalledWith(hash);
			expect(destinationRefresh).not.toHaveBeenCalled();
			expect(sourceInjection).not.toHaveBeenCalled();
			expect(destinationInjection).toHaveBeenCalledTimes(1);
			expect(source.clientHost).toBe("fixture");
			expect(
				(await db<{ name: string }>("client_searchee")
					.where("client_host", "other")
					.first())!.name,
			).toBe("other");
			if ("destinationDir" in result)
				expect(
					(await stat(join(result.destinationDir!, "renamed.mkv")))
						.ino,
				).toBe((await stat(join(moved, "renamed.mkv"))).ino);
		} finally {
			info.save_path = oldPath;
			sourceRefresh.mockRestore();
			destinationRefresh.mockRestore();
			sourceInjection.mockRestore();
			destinationInjection.mockRestore();
			setClientsForTesting([client]);
		}
	});

	it("keeps the direct injection exemption", async () => {
		const source = await actionSource(Label.INJECT);
		await performActionWithoutMutex(
			meta,
			Decision.MATCH,
			source,
			"fixture",
			undefined,
			{ onlyCompleted: false },
		);
		expect(
			requests.filter((r) =>
				["/torrents/files", "/torrents/trackers"].includes(r.route),
			),
		).toHaveLength(0);
		expect(source.files[0].path).toBe("old.mkv");
	});
	it("refreshes metadata before enforcing onlyCompleted", async () => {
		const source = await actionSource(Label.SEARCH);
		const result = await performActionWithoutMutex(
			meta,
			Decision.MATCH,
			source,
			"fixture",
		);
		expect(result.actionResult).toBe(InjectionResult.TORRENT_NOT_COMPLETE);
		expect(source.savePath).toBe(info.save_path);
		expect(source.files[0].path).toBe("renamed.mkv");
		expect(
			requests
				.filter((r) => r.route === "/torrents/info")
				.every((r) => r.hashes === hash),
		).toBe(true);
	});

	it("links a completed source from its refreshed moved path and renamed file", async () => {
		const source = await actionSource(Label.SEARCH);
		const moved = join(config, "moved");
		const links = join(config, "links");
		await mkdir(moved, { recursive: true });
		await mkdir(links, { recursive: true });
		await writeFile(join(moved, "renamed.mkv"), Buffer.alloc(100));
		const oldPath = info.save_path;
		info.save_path = moved;
		info.state = "uploading";
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			action: Action.INJECT,
			linkDirs: [links],
			linkType: LinkType.HARDLINK,
			outputDir: config,
		});
		const newMeta = new Metafile({
			info: {
				name: Buffer.from("renamed.mkv"),
				length: 100,
				"piece length": 16384,
				pieces: Buffer.alloc(20),
				private: 1,
			},
		});
		const injection = vi
			.spyOn(client, "inject")
			.mockResolvedValue(InjectionResult.SUCCESS);
		try {
			const result = await performActionWithoutMutex(
				newMeta,
				Decision.MATCH,
				source,
				"fixture",
				undefined,
				{ onlyCompleted: true },
			);
			expect(result.actionResult).toBe(InjectionResult.SUCCESS);
			expect("destinationDir" in result).toBe(true);
			if ("destinationDir" in result)
				expect(
					(await stat(join(result.destinationDir!, "renamed.mkv")))
						.ino,
				).toBe((await stat(join(moved, "renamed.mkv"))).ino);
			expect(source.savePath).toBe(moved);
		} finally {
			info.save_path = oldPath;
			injection.mockRestore();
		}
	});
	it("uses the existing full refresh fallback for other adapters", async () => {
		const source = await actionSource(Label.SEARCH);
		const fallback = {
			...client,
			refreshOne: undefined,
			getClientSearchees: (options: unknown) => {
				expect(options).toEqual({
					newSearcheesOnly: true,
					refresh: [hash],
				});
				return Promise.resolve({
					searchees: [source],
					newSearchees: [source],
				});
			},
		};
		expect(
			await refreshClientSearchee(
				fallback as unknown as import("../src/clients/TorrentClient.js").TorrentClient,
				hash,
			),
		).toBe(source);
	});
});
