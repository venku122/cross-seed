import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import type { ClientSearcheeRow } from "../src/searchee.js";

const root = await mkdtemp(join(tmpdir(), "client-publication-adapters-"));
process.env.CONFIG_DIR = root;
const { db } = await import("../src/db.js");
const logging = await import("../src/logger.js");
logging.initializeLogger({ verbose: false });
logging.logger.silent = true;
const { default: Transmission } =
	await import("../src/clients/Transmission.js");
const { default: Deluge } = await import("../src/clients/Deluge.js");
const hash = "a".repeat(40);
let present = true,
	fail = false,
	placement = "/old";
let responseGate: (() => Promise<void>) | undefined;
const server = createServer(async (req, res) => {
	req.resume();
	const deluge = req.url === "/deluge";
	const torrent = deluge
		? {
				name: "Fixture",
				save_path: placement,
				total_size: 1,
				label: "",
				files: [{ path: "file", size: 1 }],
				trackers: [],
			}
		: {
				name: "Fixture",
				hashString: hash,
				downloadDir: placement,
				totalSize: 1,
				labels: [],
				files: [{ name: "file", length: 1, bytesCompleted: 1 }],
				trackers: [],
			};
	const payload = JSON.stringify(
		deluge
			? {
					id: 0,
					error: fail
						? { code: 1, message: "fixture failure" }
						: null,
					result: { torrents: present ? { [hash]: torrent } : {} },
				}
			: {
					result: fail ? "fixture failure" : "success",
					arguments: { torrents: present ? [torrent] : [] },
				},
	);
	await responseGate?.();
	res.setHeader("content-type", "application/json");
	res.end(payload);
});
let endpoint: string;
beforeAll(async () => {
	await db.migrate.latest();
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
	present = true;
	fail = false;
	placement = "/old";
	responseGate = undefined;
	await db("client_searchee").del();
});
afterAll(async () => {
	await db.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(root, { recursive: true, force: true });
});
function gate() {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { pending, release };
}
for (const kind of ["transmission", "deluge"] as const) {
	describe(`${kind} complete publication transport`, () => {
		function client() {
			return kind === "transmission"
				? new Transmission(`${endpoint}/${kind}`, kind, 0, true)
				: new Deluge(`${endpoint}/${kind}`, kind, 0, true);
		}
		it("reconciles a validated empty inventory", async () => {
			const adapter = client();
			await adapter.getClientSearchees({ refresh: [] });
			present = false;
			expect(await adapter.getClientSearchees({ refresh: [] })).toEqual({
				searchees: [],
				newSearchees: [],
			});
			expect(
				await db("client_searchee").where("client_host", kind),
			).toHaveLength(0);
		});
		it("rejects a superseded HTTP snapshot instead of returning stale linking metadata", async () => {
			const adapter = client();
			const entered = gate(),
				held = gate();
			let blocked = false;
			responseGate = async () => {
				if (!blocked) {
					blocked = true;
					entered.release();
					await held.pending;
				}
			};
			const old = adapter.getClientSearchees({ refresh: [] });
			const rejected = expect(old).rejects.toThrow("concurrency");
			await entered.pending;
			placement = "/new";
			await adapter.getClientSearchees({ refresh: [] });
			held.release();
			await rejected;
			expect(
				(
					await db<ClientSearcheeRow>("client_searchee")
						.where({ client_host: kind, info_hash: hash })
						.first()
				)?.save_path,
			).toBe("/new");
		});
		it("preserves cached metadata on a failed inventory RPC", async () => {
			const adapter = client();
			await adapter.getClientSearchees({ refresh: [] });
			present = false;
			fail = true;
			await expect(
				adapter.getClientSearchees({ refresh: [] }),
			).rejects.toThrow();
			expect(
				await db("client_searchee")
					.where({ client_host: kind, info_hash: hash })
					.first(),
			).toBeDefined();
		});
	});
}
