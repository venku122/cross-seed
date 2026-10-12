import { setImmediate } from "node:timers/promises";
import { db } from "./db.js";
import type { EnsembleEntry } from "./torrent.js";
import type { SearcheeWithInfoHash } from "./searchee.js";

let nextStageId = 0;

/**
 * Stage bounded rows without reserving SQLite's sole connection during generation.
 * The ordered atomic apply preserves the old conflict/winner and rollback semantics.
 * The final statement still blocks timers. Client/file arrays and generated
 * entries for up to 64 concurrent sources remain materialized. TEMP staging
 * relies on SQLite's one-entry pool.
 */
export async function writeEnsembleTorrentEntries(
	sources: readonly SearcheeWithInfoHash[],
	createEntries: (
		source: SearcheeWithInfoHash,
	) => Promise<EnsembleEntry[] | null>,
): Promise<void> {
	if (!sources.length) return;
	const stage = `ensemble_stage_${++nextStageId}`;
	await db.raw(
		`CREATE TEMP TABLE ?? (seq INTEGER PRIMARY KEY, client_host TEXT, path TEXT NOT NULL, info_hash TEXT, ensemble TEXT NOT NULL, element TEXT NOT NULL)`,
		[stage],
	);
	try {
		let rows: (EnsembleEntry & { seq: number })[] = [];
		let sequence = 0;
		let sourcesSinceYield = 0;
		const flush = async () => {
			if (!rows.length) return;
			await db(stage).insert(rows);
			rows = [];
			sourcesSinceYield = 0;
			await setImmediate();
		};

		for (let offset = 0; offset < sources.length; offset += 64) {
			// Wait for the entire bounded group, including failures, so no client
			// reads outlive this rebuild and ordered callbacks never write staging.
			const generated = await Promise.allSettled(
				sources
					.slice(offset, offset + 64)
					.map((source) => createEntries(source)),
			);
			const failure = generated.find(
				(result) => result.status === "rejected",
			);
			if (failure) throw failure.reason;
			for (const result of generated) {
				if (result.status !== "fulfilled") continue;
				for (const entry of result.value ?? []) {
					rows.push({ ...entry, seq: ++sequence });
					if (rows.length === 500) await flush();
				}
				if (++sourcesSinceYield === 256) {
					sourcesSinceYield = 0;
					await setImmediate();
				}
			}
		}

		await flush();
		if (sequence)
			await db.raw(
				`INSERT INTO ensemble(client_host,path,info_hash,ensemble,element) SELECT client_host,path,info_hash,ensemble,element FROM ?? WHERE 1 ORDER BY seq ON CONFLICT(client_host,path) DO UPDATE SET info_hash=excluded.info_hash,ensemble=excluded.ensemble,element=excluded.element`,
				[stage],
			);
	} finally {
		await db.raw("DROP TABLE ??", [stage]);
	}
}
