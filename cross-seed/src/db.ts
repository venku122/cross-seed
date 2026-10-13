import { performance } from "node:perf_hooks";
import {
	performanceRecorder,
	recordPerformance,
} from "./performanceTelemetry.js";
import {
	sourceMembershipQuery,
	type SourceMembershipRow,
} from "./sourceStore.js";
import { invalidateHealth } from "./healthGeneration.js";
import { access, unlink } from "fs/promises";
import knex from "knex";
import type { Knex } from "knex";
import BetterSqlite3ClientImport from "knex/lib/dialects/better-sqlite3/index.js";
import ms from "ms";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkerConnection } from "./sqliteWorker.js";
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
	findAllTorrentFilesInDir,
	parseTorrentFromPath,
	snatchHistory,
} from "./torrent.js";
import {
	filterAsync,
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
	async acquireRawConnection() {
		const { filename } = this
			.connectionSettings as Knex.BetterSqlite3ConnectionConfig;
		if (process.env.CROSS_SEED_SQLITE_WORKER === "1") {
			return SqliteWorkerConnection.open(filename);
		}
		const connection = new this.driver(filename);
		connection.exec("pragma journal_mode = WAL; pragma foreign_keys = ON;");
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
			useAll =
				Boolean(obj.returning) ||
				/^(select|pragma|explain|with)\b/.test(sql);
		}

		if (useAll) {
			obj.response =
				connection instanceof SqliteWorkerConnection
					? await connection.execute(obj.sql, bindings, true)
					: connection.prepare(obj.sql).all(...bindings);
			return obj;
		}

		const response =
			connection instanceof SqliteWorkerConnection
				? await connection.execute(obj.sql, bindings, false)
				: connection.prepare(obj.sql).run(...bindings);
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
	// TEMP staging and transactions have exactly one connection owner.
	pool: { min: 1, max: 1 },
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
		const pathsFrom = (
			table: "data" | "ensemble",
		): Knex.QueryBuilder<{ path: string }, { path: string }[]> => {
			const query =
				table === "data"
					? db<{ path: string }>("data")
							.select<{ path: string }[]>("path")
							.whereNotNull("path")
					: db<{ path: string }>()
							.from(sourceMembershipQuery(db).as("memberships"))
							.select<{ path: string }[]>("path");
			if (lastPath !== undefined) query.where("path", ">", lastPath);
			// Both SQL branches select exactly one path. Knex's aliased
			// subquery overload loses that record type at this boundary.
			return query as unknown as Knex.QueryBuilder<
				{ path: string },
				{ path: string }[]
			>;
		};
		const query = dataDirs.length
			? pathsFrom("data")
			: pathsFrom("ensemble");
		if (dataDirs.length && seasonFromEpisodes) {
			query.union(pathsFrom("ensemble"));
		} else {
			query.distinct(db.raw("path"));
		}
		const page = await query.orderBy("path", "asc").limit(512);
		if (!page.length) return;
		lastPath = page[page.length - 1].path;
		// Capture revisions before filesystem awaits. A watcher or refresh that
		// publishes during the probe keeps its new source visible.
		const observed = await sourceMembershipQuery(db)
			.whereIn(
				"p.path",
				page.map((row) => row.path),
			)
			.select<Array<SourceMembershipRow & { revision: number }>>(
				"o.revision",
			);
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
					let changed = false;
					await db.transaction(async (trx) => {
						const revisions = [
							...new Map(
								observed
									.filter((row) => batch.includes(row.path))
									.map((row) => [
										row.origin_id,
										[row.origin_id, row.revision],
									]),
							).values(),
						];
						if (revisions.length) {
							// A single bounded update checks every captured revision.
							changed = Boolean(
								await trx("source_origin")
									.whereIn(["id", "revision"], revisions)
									.update({
										state: "unavailable",
										revision: trx.raw("revision + 1"),
									}),
							);
						}
					});
					if (changed) invalidateHealth();
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
	if (process.env.CROSS_SEED_PERFORMANCE_TELEMETRY !== "1")
		return cleanupDBImpl();
	const started = performance.now();
	let sqlQueries = 0;
	const count = () => {
		sqlQueries++;
	};
	db.on("query", count);
	try {
		await cleanupDBImpl();
	} finally {
		db.off("query", count);
		recordPerformance({
			operation: "cleanup",
			durationMs: performance.now() - started,
			sqlQueries,
		});
		logger.verbose({
			label: Label.CLEANUP,
			message: `Aggregate performance: ${JSON.stringify(performanceRecorder.snapshot())}`,
		});
	}
}

async function cleanupDBImpl(): Promise<void> {
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
		// Each adapter commits authoritative metadata and memberships together.
		// Release a client's returned catalog before refreshing the next one;
		// never regenerate from an RPC array after its publication lease ended.
		for (const client of getClients()) {
			try {
				await client.getClientSearchees({
					refresh: [],
					includeFiles: true,
					includeTrackers: true,
				});
			} catch (error) {
				logger.error({
					label: Label.CLEANUP,
					message: `Failed to refresh ${client.label}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
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
