import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { TorrentClient } from "../src/clients/TorrentClient.js";
import type { SearcheeClient } from "../src/searchee.js";
const directory = await mkdtemp(join(tmpdir(), "client-fallback-"));
process.env.CONFIG_DIR = directory;
const { refreshClientSearchee } =
	await import("../src/clients/TorrentClient.js");
const { ClientCacheConcurrencyError } =
	await import("../src/clientCachePublication.js");
const { db } = await import("../src/db.js");
afterAll(async () => {
	await db.destroy();
	await rm(directory, { recursive: true, force: true });
});
const current: SearcheeClient = {
	infoHash: "fixture",
	name: "Fixture",
	title: "Fixture",
	clientHost: "fixture",
	savePath: "/new",
	files: [{ name: "media", path: "media", length: 1 }],
	length: 1,
	trackers: [],
};
it("retries a rejected fallback publication using a fresh adapter operation", async () => {
	let requests = 0;
	const client = {
		getClientSearchees: () => {
			if (++requests === 1)
				return Promise.reject(new ClientCacheConcurrencyError());
			return Promise.resolve({
				searchees: [current],
				newSearchees: [current],
			});
		},
	} as unknown as TorrentClient;
	expect(await refreshClientSearchee(client, "fixture")).toEqual(current);
	expect(requests).toBe(2);
});
it("bounds fallback concurrency retries and preserves unrelated errors", async () => {
	let requests = 0;
	const client = {
		getClientSearchees: () => {
			requests++;
			return Promise.reject(new ClientCacheConcurrencyError());
		},
	} as unknown as TorrentClient;
	await expect(
		refreshClientSearchee(client, "fixture"),
	).rejects.toBeInstanceOf(ClientCacheConcurrencyError);
	expect(requests).toBe(3);
	const transport = new Error("transport fixture");
	client.getClientSearchees = () => {
		requests++;
		return Promise.reject(transport);
	};
	await expect(refreshClientSearchee(client, "fixture")).rejects.toBe(
		transport,
	);
	expect(requests).toBe(4);
});
