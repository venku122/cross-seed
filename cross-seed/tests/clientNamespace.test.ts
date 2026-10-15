import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const config = await mkdtemp(join(tmpdir(), "client-namespace-"));
process.env.CONFIG_DIR = config;
const { getDefaultRuntimeConfig } = await import("../src/configuration.js");
const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
const { instantiateDownloadClients, getClients, resetClientsForTesting } =
	await import("../src/clients/TorrentClient.js");
const { db } = await import("../src/db.js");

afterAll(async () => {
	resetClientsForTesting();
	await db.destroy();
	await rm(config, { recursive: true, force: true });
});

function configure(entries: string[]) {
	resetClientsForTesting();
	setRuntimeConfig({ ...getDefaultRuntimeConfig(), torrentClients: entries });
	instantiateDownloadClients();
	return getClients().map((client) => client.clientHost);
}

describe("stable client endpoint placement", () => {
	it("retains a proxy client's identity when another client is added", () => {
		const first = "qbittorrent:http://fixture.invalid/qb-one/";
		const alone = configure([first])[0];
		const together = configure([
			first,
			"qbittorrent:http://fixture.invalid/qb-two/",
		])[0];
		expect(together).toBe(alone);
	});
	it("normalizes path delimiters independently of credentials", () => {
		const first = configure([
			"qbittorrent:http://before:secret@fixture.invalid/qb-one/",
		])[0];
		const second = configure([
			"qbittorrent:http://after:changed@fixture.invalid/qb-one",
		])[0];
		expect(second).toBe(first);
		expect(second).toBe("fixture.invalid/qb-one");
	});
	it("preserves the root endpoint host label", () => {
		expect(configure(["qbittorrent:http://fixture.invalid/"])[0]).toBe(
			"fixture.invalid",
		);
	});
});
