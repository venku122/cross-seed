import { access, unlink } from "fs/promises";
import knex from "knex";
import type { Knex } from "knex";
import BetterSqlite3ClientImport from "knex/lib/dialects/better-sqlite3/index.js";
import ms from "ms";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { basename, join } from "path";
import { getClients } from "./clients/TorrentClient.js";
import { appDir } from "./configuration.js";
import { TORRENT_CACHE_FOLDER } from "./constants.js";
import { getCachedTorrentName, rebuildGuidInfoHashMap } from "./decide.js";
import { Label, logger } from "./logger.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import { migrations } from "./migrations/migrations.js";
import { Metafile } from "./parseTorrent.js";
import {
	cacheEnsembleTorrentEntry,
	findAllTorrentFilesInDir,
	parseTorrentFromPath,
	snatchHistory,
} from "./torrent.js";
import {
	filterAsync,
	flatMapAsync,
	errorMessage,
	getLogString,
	humanReadableDate,
	inBatches,
	yieldToEventLoop,
} from "./utils.js";

type KnexClientCtor = typeof Knex.Client;
const BetterSqlite3Client =
	BetterSqlite3ClientImport as unknown as KnexClientCtor;

const formatBindings = (bindings?: Array<unknown>) => {
	if (!bindings) return [];
	return bindings.map((binding) => {
		if (binding instanceof Date) {
			return binding.valueOf();
		}
		if (typeof binding === "boolean") {
			return Number(binding);
		}
		return binding;
	});
};

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
export class NodeSqliteClient extends BetterSqlite3Client {
	_driver() {
		return DatabaseSync;
	}

	// Get a raw connection from the database, returning a promise with the connection object.
	// eslint-disable-next-line @typescript-eslint/require-await
	async acquireRawConnection() {
		const { filename } = this
			.connectionSettings as Knex.BetterSqlite3ConnectionConfig;
		const connection = new this.driver(filename);
		connection.exec("pragma journal_mode = WAL;");
		return connection;
	}

	// Used to explicitly close a connection, called internally by the pool when
	// a connection times out or the pool is shutdown.
	// eslint-disable-next-line @typescript-eslint/require-await
	async destroyRawConnection(connection: any) {
		return connection.close();
	}

	// Runs the query on the specified connection, providing the bindings and any
	// other necessary prep work.
	async _query(connection: any, obj: any) {
		if (!obj.sql) throw new Error("The query is empty");

		if (!connection) {
			throw new Error("No connection provided");
		}

		const statement = connection.prepare(obj.sql);
		const bindings = formatBindings(obj.bindings);

		const method = obj.method;
		let useAll: boolean;
		switch (method) {
			case "insert":
			case "update":
				useAll = Boolean(obj.returning);
				break;
			case "counter":
			case "del":
				useAll = false;
				break;
			default:
				useAll = true;
		}
		if (method == null) {
			const sql = obj.sql.trim().toLowerCase();
			useAll = Boolean(obj.returning) || sql.startsWith("select");
		}

		if (useAll) {
			obj.response = await statement.all(...bindings);
			return obj;
		}

		const response = await statement.run(...bindings);
		obj.response = response;
		obj.context = {
			lastID: response.lastInsertRowid,
			changes: response.changes,
		};

		return obj;
	}
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
NodeSqliteClient.prototype.driverName = "node:sqlite";

const filename = join(appDir(), "cross-seed.db");

export const db = knex({
	client: NodeSqliteClient,
	connection: { filename },
	migrations: { migrationSource: migrations },
	useNullAsDefault: true,
});

/**
 * Merge indexed path streams so each filesystem path is checked once, including
 * paths with multiple ensemble memberships. Keysets remain valid after deletes;
 * watcher inserts behind the cursor are picked up by the next cleanup.
 */
async function pruneMissingCachedPaths(
	dataDirs: string[],
	seasonFromEpisodes: number | undefined,
): Promise<void> {
	let lastPath: string | undefined;
	let processed = 0;
	let pages = 0;
	for (;;) {
		const pathsFrom = (table: "data" | "ensemble") => {
			const query = db<{ path: string }>(table)
				.select("path")
				.whereNotNull("path");
			if (lastPath !== undefined) query.where("path", ">", lastPath);
			return query;
		};
		const query = dataDirs.length
			? pathsFrom("data")
			: pathsFrom("ensemble");
		if (dataDirs.length && seasonFromEpisodes) {
			query.union(pathsFrom("ensemble"));
		} else {
			query.distinct("path");
		}
		const page = await query.orderBy("path", "asc").limit(512);
		if (!page.length) return;
		lastPath = page[page.length - 1].path;
		let uncertainPaths = 0;
		const missingPaths: string[] = [];
		await inBatches(
			page,
			async (batch) => {
				missingPaths.push(
					...(await filterAsync(
						batch.map(({ path }) => path),
						async (path) => {
							try {
								await access(path);
								return false;
							} catch (error) {
								const code = (error as NodeJS.ErrnoException)
									.code;
								if (code === "ENOENT" || code === "ENOTDIR")
									return true;
								uncertainPaths++;
								return false;
							}
						},
					)),
				);
			},
			{ batchSize: 64 },
		);
		if (missingPaths.length) {
			// Guard only destructive pages. An unavailable root is not evidence
			// of deleted files; stop filesystem pruning but allow housekeeping.
			let unavailableRoot = false;
			await inBatches(
				dataDirs,
				async (roots) => {
					await Promise.all(
						roots.map(async (root) => {
							try {
								await access(root);
							} catch {
								unavailableRoot = true;
							}
						}),
					);
				},
				{ batchSize: 64 },
			);
			if (unavailableRoot) {
				logger.warn({
					label: Label.CLEANUP,
					message:
						"Skipping filesystem cache pruning because a configured data root is unavailable...",
				});
				return;
			}
			await inBatches(
				missingPaths,
				async (batch) => {
					await db.transaction(async (trx) => {
						await trx("data").whereIn("path", batch).del();
						await trx("ensemble").whereIn("path", batch).del();
					});
				},
				{ batchSize: 64 },
			);
		}
		if (uncertainPaths) {
			logger.verbose({
				label: Label.CLEANUP,
				message: `Retained ${uncertainPaths} cached paths due to filesystem access errors...`,
			});
		}
		processed += page.length;
		if (++pages % 100 === 0) {
			logger.verbose({
				label: Label.CLEANUP,
				message: `Checked ${processed} cached filesystem paths...`,
			});
		}
		if (page.length < 512) return;
		await setImmediate();
	}
}

export async function cleanupDB(): Promise<void> {
	const {
		dataDirs,
		excludeRecentSearch,
		seasonFromEpisodes,
		useClientTorrents,
	} = getRuntimeConfig();
	await (async () => {
		if (!useClientTorrents) return;
		logger.verbose({
			label: Label.CLEANUP,
			message: "Refreshing all client torrents...",
		});
		const searchees = await flatMapAsync(getClients(), async (client) => {
			try {
				return (
					await client.getClientSearchees({
						refresh: [],
						includeFiles: true,
						includeTrackers: true,
					})
				).searchees;
			} catch (error) {
				logger.error({
					label: Label.CLEANUP,
					message: `Failed to refresh ${client.label}: ${error instanceof Error ? error.message : String(error)}`,
				});
				return [];
			}
		});
		if (!seasonFromEpisodes) return;
		logger.verbose({
			label: Label.CLEANUP,
			message: "Refreshing all ensemble torrents...",
		});
		const ensembleRows = await flatMapAsync(
			searchees,
			async (searchee) =>
				(await cacheEnsembleTorrentEntry(searchee)) ?? [],
		);
		await inBatches(ensembleRows, async (batch) => {
			await db("ensemble")
				.insert(batch)
				.onConflict(["client_host", "path"])
				.merge();
		});
	})();
	if (dataDirs.length || seasonFromEpisodes) {
		logger.verbose({
			label: Label.CLEANUP,
			message: "Pruning deleted cached filesystem entries...",
		});
		await pruneMissingCachedPaths(dataDirs, seasonFromEpisodes);
	}
	(() => {
		logger.verbose({
			label: Label.CLEANUP,
			message: "Pruning failed snatch history entries...",
		});
		for (const [
			str,
			{ initialFailureAt, numFailures },
		] of snatchHistory.entries()) {
			if (Date.now() - initialFailureAt > ms("1 day")) {
				logger.verbose({
					label: Label.CLEANUP,
					message: `Deleting snatch history entry for ${str}: ${numFailures} failures`,
				});
				snatchHistory.delete(str);
			}
		}
	})();
	await (async () => {
		logger.verbose({
			label: Label.CLEANUP,
			message: "Pruning unused torrent cache entries...",
		});
		const excludeCutoff = (excludeRecentSearch ?? 0) + ms("30 days");
		let cutoffMs = ms("1 year");
		let logCutoff = "1 year";
		if (excludeCutoff > cutoffMs) {
			cutoffMs = excludeCutoff;
			logCutoff = `your excludeRecentSearch of ${(excludeRecentSearch! / 1000 / 60 / 60 / 24).toFixed(2)} days`;
		}
		const torrentPaths = await findAllTorrentFilesInDir(
			join(appDir(), TORRENT_CACHE_FOLDER),
		);
		if (!torrentPaths.length) return;
		const infoHashLastSeenMap = (
			await db("decision").select("info_hash", "last_seen")
		).reduce<Map<string, number>>((acc, cur) => {
			if (!cur.info_hash || !cur.last_seen) return acc;
			if (!acc.has(cur.info_hash)) {
				acc.set(cur.info_hash, cur.last_seen);
			} else if (cur.last_seen > acc.get(cur.info_hash)!) {
				acc.set(cur.info_hash, cur.last_seen);
			}
			return acc;
		}, new Map<string, number>());
		if (!infoHashLastSeenMap.size) return;
		const hashesToDelete: string[] = [];
		const now = Date.now();
		for (const [index, torrentPath] of torrentPaths.entries()) {
			if (index % 1000 === 0) await yieldToEventLoop();
			const infoHash = basename(torrentPath).split(".")[0];
			const lastSeen = infoHashLastSeenMap.get(infoHash);
			if (lastSeen && now - lastSeen <= cutoffMs) continue;
			let meta: Metafile | null = null;
			try {
				meta = await parseTorrentFromPath(torrentPath);
			} catch (e) {
				logger.error({
					label: Label.CLEANUP,
					message: `Failed to parse ${torrentPath} when cleaning up unused torrents: ${errorMessage(e)}`,
				});
				logger.debug(e);
			}
			const logEntry = meta
				? `${getLogString(meta)} (${torrentPath})`
				: torrentPath;
			logger.verbose({
				label: Label.CLEANUP,
				message: `Deleting unused torrent cache entry for ${logEntry} - it has not been accessed in over ${logCutoff} - ${humanReadableDate(lastSeen ?? 0)}`,
			});
			try {
				await unlink(torrentPath);
				hashesToDelete.push(infoHash); // Pruning invalid decision entries will catch any interruptions or race conditions
			} catch (e) {
				logger.error({
					label: Label.CLEANUP,
					message: `Failed to delete ${torrentPath} when cleaning up unused torrents: ${errorMessage(e)}`,
				});
				logger.debug(e);
			}
		}
		await inBatches(hashesToDelete, async (batch) => {
			await db("decision").whereIn("info_hash", batch).del();
		});
	})();
	await (async () => {
		logger.verbose({
			label: Label.CLEANUP,
			message: "Pruning invalid decision entries...",
		});
		await db("decision").whereNull("info_hash").del();
		const dbRows: { name: string | null; info_hash: string | null }[] =
			await db("decision")
				.leftJoin("searchee", "decision.searchee_id", "searchee.id")
				.select("searchee.name", "decision.info_hash");
		if (!dbRows.length) return;
		const torrentCacheDir = join(appDir(), TORRENT_CACHE_FOLDER);
		const torrentPaths = new Set(
			await findAllTorrentFilesInDir(torrentCacheDir),
		);
		if (!torrentPaths.size) return;
		let validRows = 0;
		const hashesToDelete = new Set<string>();
		for (const dbRow of dbRows) {
			if (validRows % 1000 === 0) await yieldToEventLoop();
			if (!dbRow.info_hash) continue;
			validRows++;
			const torrentPath = join(
				torrentCacheDir,
				getCachedTorrentName(dbRow.info_hash),
			);
			if (torrentPaths.has(torrentPath)) continue;
			logger.verbose({
				label: Label.CLEANUP,
				message: `Deleting invalid decision entries for ${dbRow.info_hash} (related to ${dbRow.name}) - missing .torrent file in cache`,
			});
			hashesToDelete.add(dbRow.info_hash);
		}
		if (validRows && hashesToDelete.size === validRows) {
			logger.verbose({
				label: Label.CLEANUP,
				message:
					"All decision entries are invalid - skipping deletion to avoid catastrophic data loss",
			});
			return;
		}
		await inBatches(Array.from(hashesToDelete), async (batch) => {
			await db("decision").whereIn("info_hash", batch).del();
		});
	})();
	await (async () => {
		logger.verbose({
			label: Label.CLEANUP,
			message: "Rebuilding guid infoHash map...",
		});
		await rebuildGuidInfoHashMap();
	})();
}
