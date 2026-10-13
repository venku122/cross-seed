import type { Knex } from "knex";
import { FSWatcher, watch } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { basename, dirname, extname, join, resolve, sep, relative } from "path";
import {
	IGNORED_FOLDERS_SUBSTRINGS,
	LEVENSHTEIN_DIVISOR,
	VIDEO_EXTENSIONS,
} from "./constants.js";
import { db } from "./db.js";
import {
	ensureSourceNamespace,
	resolveSourceOrigin,
	replaceSourcePublication,
	normalizeSourceElement,
	type SourceOrigin,
} from "./sourceStore.js";
import {
	beginClientCacheOperation,
	publishClientCacheBatch,
	releaseClientCacheOperation,
	ClientCacheConcurrencyError,
	type ClientCacheLease,
} from "./clientCachePublication.js";
import { Label, logger } from "./logger.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import {
	createSearcheeFromPath,
	File,
	getFilesFromDataRoot,
	parseTitle,
	SearcheeWithoutInfoHash,
} from "./searchee.js";
import { createEnsemblePieces, EnsembleEntry } from "./torrent.js";
import {
	createKeyTitle,
	errorMessage,
	exists,
	filterAsync,
	filterAsyncYield,
	flatMapAsync,
	isTruthy,
	mapAsync,
	yieldToEventLoop,
	stripExtension,
} from "./utils.js";
import { isOk } from "./Result.js";
import { distance } from "fastest-levenshtein";

interface DataEntry {
	title: string;
	path: string;
}

const watchers: Map<string, FSWatcher> = new Map();
const modifiedPaths: Map<string, Set<string>> = new Map();
const modifiedPathTimes: Map<string, Map<string, number>> = new Map();
const STABILITY_WINDOW_MS = 60_000;

function createWatcher(dataDir: string): FSWatcher {
	return watch(dataDir, { recursive: true, persistent: false }, (_, f) => {
		if (!f) return;
		const fullPath = resolve(join(dataDir, f));
		if (fullPath === resolve(dataDir)) return;
		modifiedPaths.get(dataDir)!.add(fullPath);
		modifiedPathTimes.get(dataDir)!.set(fullPath, Date.now());
	}).on("error", (e) => {
		logger.error(`Restarting watcher for dataDir ${dataDir}: ${e.message}`);
		logger.debug(e);
		watchers.get(dataDir)!.close();
		watchers.set(dataDir, createWatcher(dataDir));
	});
}

export async function indexDataDirs(options: {
	startup: boolean;
}): Promise<void> {
	const { dataDirs, maxDataDepth } = getRuntimeConfig();
	if (!dataDirs.length) return;
	const operations = await createDataOperations(dataDirs);
	try {
		if (options.startup) {
			logger.info({
				label: Label.INDEX,
				message: "Indexing dataDirs for reverse lookup...",
			});
			for (const dataDir of dataDirs) {
				modifiedPaths.set(dataDir, new Set());
				modifiedPathTimes.set(dataDir, new Map());
				watchers.set(dataDir, createWatcher(dataDir));
			}
			const searcheePaths = await findSearcheesFromAllDataDirs();
			const maxUserWatchesPath = "/proc/sys/fs/inotify/max_user_watches";
			if (await exists(maxUserWatchesPath)) {
				const limit = parseInt(
					await readFile(maxUserWatchesPath, "utf8"),
				);
				if (limit < searcheePaths.length * 2) {
					logger.error(
						`max_user_watches too low for proper indexing of dataDirs. It is recommended to set fs.inotify.max_user_watches=1048576 in /etc/sysctl.conf (only on the host system if using docker) - current: ${limit}`,
					);
				}
			}
			const numEntries = await indexDataPaths(searcheePaths, operations);
			logger.info(`Validated ${numEntries} entries from dataDirs...`);
		}

		await mapAsync(dataDirs, async (dataDir) => {
			const modified = modifiedPaths.get(dataDir)!;
			const modifiedTimes = modifiedPathTimes.get(dataDir)!;
			const eventPaths: string[] = [];
			const now = Date.now();
			for (const path of modified) {
				const lastSeen = modifiedTimes.get(path) ?? 0;
				if (now - lastSeen < STABILITY_WINDOW_MS) continue;
				if (!modified.delete(path)) continue;
				modifiedTimes.delete(path);
				eventPaths.push(path);
			}
			if (!eventPaths.length) return;
			logger.verbose(
				`Indexing dataDir ${dataDir} due to recent changes...`,
			);
			eventPaths.sort(
				(a, b) =>
					b.split(sep).filter(isTruthy).length -
					a.split(sep).filter(isTruthy).length,
			);
			const deletedPaths: string[] = [];
			const paths = await filterAsync(
				Array.from(
					eventPaths.reduce<Set<string>>((acc, path) => {
						const affectedPaths: string[] = [path];
						let parentPath = dirname(path);
						while (resolve(parentPath) !== resolve(dataDir)) {
							affectedPaths.push(parentPath);
							parentPath = dirname(parentPath);
						}
						for (const affectedPath of affectedPaths.slice(
							-maxDataDepth,
						)) {
							acc.add(affectedPath);
						}
						return acc;
					}, new Set()),
				),
				async (path) => {
					if (await exists(path)) return true;
					deletedPaths.push(path);
					return false;
				},
			);
			// Missing paths are retained until authoritative source validation.
			void deletedPaths;
			await indexDataPaths(paths, operations);
		});
	} finally {
		for (const lease of operations.values())
			releaseClientCacheOperation(lease);
	}
}

/**
 * Adds the data and ensemble entries to the database.
 * @param paths The paths to index.
 */
async function createDataOperations(
	roots: string[],
): Promise<Map<string, ClientCacheLease>> {
	const operations = new Map<string, ClientCacheLease>();
	for (const root of roots) {
		const namespace = await ensureSourceNamespace(db, "data-root", root);
		operations.set(
			root,
			beginClientCacheOperation(`filesystem:${namespace}`),
		);
	}
	return operations;
}
export async function indexDataPaths(
	paths: string[],
	captured?: ReadonlyMap<string, ClientCacheLease>,
): Promise<number> {
	const { seasonFromEpisodes, dataDirs } = getRuntimeConfig();
	const memoizedPaths = new Map<string, string[]>();
	const memoizedLengths = new Map<string, number>();
	let processed = 0;
	const operations = captured ?? (await createDataOperations(dataDirs));
	try {
		for (const path of paths) {
			const owners = dataDirs.filter((root) => {
				const key = relative(root, path);
				return (
					key === "" ||
					(!key.startsWith(`..${sep}`) &&
						key !== ".." &&
						!key.startsWith(sep))
				);
			});
			const origins: Array<{
				origin: SourceOrigin;
				root: string;
				key: string;
			}> = [];
			for (const root of owners) {
				const ns = await ensureSourceNamespace(db, "data-root", root);
				origins.push({
					origin: await resolveSourceOrigin(
						db,
						ns,
						relative(root, path) || ".",
					),
					root,
					key: relative(root, path) || ".",
				});
			}
			// Revision is captured before filesystem traversal. Empty results from this
			// legacy scanner are ambiguous (it catches I/O errors), so preserve owners.
			const files = await getFilesFromDataRoot(
				path,
				memoizedPaths,
				memoizedLengths,
			);
			if (!files.length) continue;
			const title = parseTitle(basename(path), files, path);
			if (!title) continue;
			const memberships = seasonFromEpisodes
				? (indexEnsembleDataEntry(title, path, files) ?? [])
				: [];
			let committed = false;
			for (const { origin, root, key } of origins) {
				try {
					committed =
						(await publishClientCacheBatch(
							operations.get(root)!,
							[key],
							async (trx) => {
								if (
									!(await replaceSourcePublication(trx, {
										originId: origin.id,
										expectedRevision: origin.revision,
										revision: origin.revision + 1,
										metadata: {
											path,
											title,
											name: basename(path),
											files,
											length: files.reduce(
												(n, f) => n + f.length,
												0,
											),
										},
										memberships: memberships.map((m) => ({
											path: m.path,
											ensemble: m.ensemble,
											element: normalizeSourceElement(
												m.element,
											),
										})),
										status: "verified",
									}))
								)
									throw new ClientCacheConcurrencyError();
								await trx("data")
									.insert({ title, path })
									.onConflict("path")
									.merge();
							},
						)) || committed;
				} catch (error) {
					if (!(error instanceof ClientCacheConcurrencyError))
						throw error;
				}
			}
			if (committed) {
				processed++;
			}
			if (processed % 500 === 0) await yieldToEventLoop();
		}
		return processed;
	} finally {
		if (!captured)
			for (const lease of operations.values())
				releaseClientCacheOperation(lease);
	}
}

function indexEnsembleDataEntry(
	title: string,
	path: string,
	files: File[],
): EnsembleEntry[] | null {
	const ensemblePieces = createEnsemblePieces(title, files);
	if (!ensemblePieces || !ensemblePieces.length) return null;
	return ensemblePieces.map((ensemblePiece) => ({
		client_host: null,
		path: join(dirname(path), ensemblePiece.largestFile.path),
		info_hash: null,
		ensemble: ensemblePiece.key,
		element: ensemblePiece.element,
	}));
}

/**
 * Compatibility metadata is visible only through enabled ownership or configured unknown roots.
 * Unary + removes outer TEXT affinity so SQLite can seek the indexed JSON string path.
 */
export function enabledDataEntriesQuery(): Knex.QueryBuilder<
	DataEntry,
	DataEntry[]
> {
	const { dataDirs } = getRuntimeConfig();
	return db<DataEntry>("data as cache")
		.select<DataEntry[]>("cache.path", "cache.title")
		.where((builder) => {
			if (!dataDirs.length) {
				builder.whereRaw("0");
				return;
			}
			builder.whereExists(
				db("source_origin as origin")
					.join(
						"source_namespace as namespace",
						"namespace.id",
						"origin.namespace_id",
					)
					.select(db.raw("1"))
					.where("namespace.type", "data-root")
					.where("namespace.enabled", 1)
					.whereIn("namespace.locator", dataDirs)
					.where("origin.state", "verified")
					.whereRaw(
						"json_extract(origin.metadata,'$.path')=+cache.path",
					),
			);
			builder.orWhere((unknown) => {
				unknown.whereNotExists(
					db("source_origin as origin")
						.join(
							"source_namespace as namespace",
							"namespace.id",
							"origin.namespace_id",
						)
						.select(db.raw("1"))
						.where("namespace.type", "data-root")
						.whereRaw(
							"json_extract(origin.metadata,'$.path')=+cache.path",
						),
				);
				unknown.andWhere((paths) => {
					for (const configured of dataDirs) {
						const root = configured.replace(/\/+$/, "");
						paths
							.orWhere("cache.path", root)
							.orWhereRaw("substr(cache.path,1,?)=?", [
								root.length + 1,
								`${root}${sep}`,
							]);
					}
				});
			});
		});
}

export async function getDataByFuzzyName(
	stem: string,
): Promise<SearcheeWithoutInfoHash[]> {
	const allDataEntries: DataEntry[] = await enabledDataEntriesQuery();
	const fullMatch = createKeyTitle(stem);

	// Attempt to filter torrents in DB to match incoming data before fuzzy check
	let filteredNames: DataEntry[] = [];
	if (fullMatch) {
		filteredNames = await filterAsyncYield(allDataEntries, (dbData) => {
			const dbMatch = createKeyTitle(stripExtension(dbData.title));
			return Promise.resolve(fullMatch === dbMatch);
		});
	}

	// If none match, proceed with fuzzy name check on all names.
	filteredNames = filteredNames.length > 0 ? filteredNames : allDataEntries;

	const entriesToDelete: string[] = [];

	const candidateMaxDistance = Math.floor(stem.length / LEVENSHTEIN_DIVISOR);
	const potentialMatches = await filterAsyncYield(
		filteredNames,
		async (dbEntry) => {
			const dbTitle = stripExtension(dbEntry.title);
			const maxDistance = Math.min(
				candidateMaxDistance,
				Math.floor(dbTitle.length / LEVENSHTEIN_DIVISOR),
			);
			if (distance(stem, dbTitle) > maxDistance) return false;
			if (await exists(dbEntry.path)) return true;
			entriesToDelete.push(dbEntry.path);
			return false;
		},
	);

	void entriesToDelete;
	return (
		await mapAsync(potentialMatches, (dbData) =>
			createSearcheeFromPath(dbData.path),
		)
	)
		.filter(isOk)
		.map((r) => r.unwrap());
}

export function shouldIgnorePathHeuristically(root: string, isDir: boolean) {
	const searchBasename = basename(root);
	if (isDir) {
		return IGNORED_FOLDERS_SUBSTRINGS.includes(
			searchBasename.toLowerCase(),
		);
	} else {
		return !VIDEO_EXTENSIONS.includes(extname(searchBasename));
	}
}

export async function findPotentialNestedRoots(
	root: string,
	depth: number,
	isDirHint?: boolean,
): Promise<string[]> {
	try {
		const isDir =
			isDirHint !== undefined
				? isDirHint
				: (await stat(root)).isDirectory();
		if (depth <= 0 || shouldIgnorePathHeuristically(root, isDir)) {
			return [];
		} else if (depth > 0 && isDir) {
			const directChildren = await readdir(root, { withFileTypes: true });
			const allDescendants = await flatMapAsync(
				directChildren,
				(dirent) =>
					findPotentialNestedRoots(
						join(root, dirent.name),
						depth - 1,
						dirent.isDirectory(),
					),
			);
			return [...allDescendants, root]; // deepest paths first for memoization
		} else {
			return [root];
		}
	} catch (e) {
		logger.verbose(`Failed to process path ${root}: ${errorMessage(e)}`);
		logger.debug(e);
		return [];
	}
}

export async function findSearcheesFromAllDataDirs(): Promise<string[]> {
	const { dataDirs, maxDataDepth } = getRuntimeConfig();
	return flatMapAsync(dataDirs, async (dataDir) =>
		flatMapAsync(
			(await readdir(dataDir)).map((dirent) => join(dataDir, dirent)),
			(path) => findPotentialNestedRoots(path, maxDataDepth),
		),
	);
}
