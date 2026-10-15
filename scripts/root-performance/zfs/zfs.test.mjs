import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureTransportDestination } from "./transport-gate.mjs";
test("original proxy identities route to separate private fixtures, never live transport", () => {
	const clients = [
		{ sourceLocator: "http://original.invalid/proxy-a" },
		{ sourceLocator: "http://original.invalid/proxy-b" },
	];
	assert.equal(
		fixtureTransportDestination(
			"http://original.invalid/proxy-a/api/v2/torrents/info",
			clients,
		),
		"http://fixture:4041/source/0/api/v2/torrents/info",
	);
	assert.equal(
		fixtureTransportDestination(
			"http://original.invalid/proxy-b/api/v2/torrents/files?hash=private",
			clients,
		),
		"http://fixture:4041/source/1/api/v2/torrents/files?hash=private",
	);
	assert.throws(
		() =>
			fixtureTransportDestination(
				"http://live.invalid/api/v2/torrents/info",
				clients,
			),
		/rejected/,
	);
	assert.throws(
		() =>
			fixtureTransportDestination(
				"http://original.invalid/proxy-a/api/v2/torrents/info",
				[
					{
						sourceLocator:
							"http://user:secret@original.invalid/proxy-a",
					},
				],
			),
		/credentials/,
	);
});
test("ambiguous source transports fail rather than silently coalescing namespaces", () => {
	assert.throws(
		() =>
			fixtureTransportDestination(
				"http://original.invalid/api/v2/torrents/info",
				[
					{ sourceLocator: "http://original.invalid" },
					{ sourceLocator: "http://original.invalid" },
				],
			),
		/rejected/,
	);
});

test("cold snapshot staging keeps original untouched and rejects nonempty WAL", async () => {
	const { mkdtemp, writeFile, readFile, stat, rm } =
		await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { stageColdInput } = await import("./cold-copy.mjs");
	const directory = await mkdtemp(join(tmpdir(), "cold-stage-smoke-"));
	try {
		const source = join(directory, "snapshot.db"),
			copy = join(directory, "copy.db");
		await writeFile(source, "synthetic");
		await stageColdInput(source, copy);
		assert.equal(await readFile(source, "utf8"), "synthetic");
		assert.equal(await readFile(copy, "utf8"), "synthetic");
		assert.equal((await stat(copy)).mode & 0o777, 0o600);
		await writeFile(source + "-wal", "uncheckpointed");
		await assert.rejects(
			stageColdInput(source, join(directory, "rejected.db")),
			/nonempty WAL/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
