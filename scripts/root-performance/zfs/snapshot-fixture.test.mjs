import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
test("snapshot replay keeps catalog light and reconstructs lazy files and tracker URLs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "snapshot-replay-test-"));
	const dbPath = join(directory, "input.db"),
		configPath = join(directory, "config.json");
	const db = new DatabaseSync(dbPath);
	db.exec(
		"CREATE TABLE client_searchee(client_host TEXT,info_hash TEXT,name TEXT,save_path TEXT,category TEXT,tags TEXT,length INTEGER,files TEXT,trackers TEXT)",
	);
	db.prepare("INSERT INTO client_searchee VALUES(?,?,?,?,?,?,?,?,?)").run(
		"client",
		"abc",
		"fixture",
		"/data",
		"",
		"[]",
		7,
		JSON.stringify([{ path: "Episode.mkv", length: 7 }]),
		JSON.stringify(["tracker.example:443"]),
	);
	db.close();
	await writeFile(
		configPath,
		JSON.stringify({ clients: [{ clientHost: "client" }] }),
	);
	const child = spawn(
		process.execPath,
		[new URL("./snapshot-fixture.mjs", import.meta.url).pathname],
		{
			env: {
				...process.env,
				SNAPSHOT_DB: dbPath,
				PRIVATE_CONFIG: configPath,
			},
			stdio: "ignore",
		},
	);
	const exited = once(child, "exit");
	try {
		let ready = false;
		for (let i = 0; i < 100; i++) {
			try {
				ready = (await fetch("http://127.0.0.1:4041/bench/stats")).ok;
			} catch {}
			if (ready) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(ready);
		const rpc = async (route, body = "") =>
			(
				await fetch(
					"http://127.0.0.1:4041/source/0/api/v2/torrents/" + route,
					{ method: "POST", body },
				)
			).json();
		const info = await rpc("info");
		assert.equal(info[0].hash, "abc");
		assert.equal(info[0].files, undefined);
		assert.equal(info[0].trackers, undefined);
		assert.deepEqual(await rpc("files", "hash=abc"), [
			{
				name: "Episode.mkv",
				size: 7,
				index: 0,
				progress: 1,
				priority: 1,
			},
		]);
		assert.deepEqual(await rpc("trackers", "hash=abc"), [
			{ url: "udp://tracker.example:443/announce", status: 2 },
		]);
		assert.equal(
			new URL((await rpc("trackers", "hash=abc"))[0].url).host,
			"tracker.example:443",
		);
		assert.equal(
			(
				await fetch(
					"http://127.0.0.1:4041/source/0/api/v2/torrents/delete",
					{ method: "POST" },
				)
			).status,
			405,
		);
	} finally {
		child.kill();
		await exited;
		await rm(directory, { recursive: true, force: true });
	}
});
