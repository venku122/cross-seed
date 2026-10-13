import { setImmediate } from "node:timers/promises";
import {
	beginClientCacheOperation,
	releaseClientCacheOperation,
	completeClientCacheSnapshot,
	publishClientCacheBatch,
	type ClientCacheLease,
} from "./clientCachePublication.js";
import { readdir, stat } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "path";
import ms from "ms";
import { humanReadableSize } from "@cross-seed/shared/utils";
import {
	byClientHostPriority,
	getClients,
	TorrentMetadataInClient,
} from "./clients/TorrentClient.js";
import type { Problem } from "./problems.js";
import {
	ABS_WIN_PATH_REGEX,
	AKA_REGEX,
	ANIME_GROUP_REGEX,
	ANIME_REGEX,
	ARR_DIR_REGEX,
	AUDIO_EXTENSIONS,
	BAD_GROUP_PARSE_REGEX,
	BOOK_EXTENSIONS,
	EP_REGEX,
	MediaType,
	MOVIE_REGEX,
	parseSource,
	RELEASE_GROUP_REGEX,
	REPACK_PROPER_REGEX,
	RES_STRICT_REGEX,
	SEASON_REGEX,
	SONARR_SUBFOLDERS_REGEX,
	VIDEO_DISC_EXTENSIONS,
	VIDEO_EXTENSIONS,
} from "./constants.js";
import { db } from "./db.js";
import { Label, logger } from "./logger.js";
import { Metafile } from "./parseTorrent.js";
import { Result, resultOf, resultOfErr } from "./Result.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import {
	normalizeSourceLocator,
	ensureSourceNamespace,
	resolveSourceOrigin,
	replaceSourcePublication,
	tombstoneSourceOrigin,
	normalizeSourceElement,
} from "./sourceStore.js";
import { createEnsemblePieces, parseTorrentWithMetadata } from "./torrent.js";
import {
	comparing,
	createKeyTitle,
	extractInt,
	filesWithExt,
	flatMapAsync,
	getLogString,
	hasExt,
	humanReadableDate,
	inBatches,
	isBadTitle,
	isTruthy,
	errorMessage,
	notExists,
	mapAsync,
	stripExtension,
	WithRequired,
	WithUndefined,
	withMutex,
	Mutex,
} from "./utils.js";

export interface File {
	name: string;
	path: string;
	length: number;
}

export type SearcheeLabel =
	| Label.SEARCH
	| Label.RSS
	| Label.INJECT
	| Label.ANNOUNCE
	| Label.WEBHOOK;

export interface Searchee {
	/** Runtime provenance captured before source scanning; used for conditional publication. */
	sourceRevision?: number;
	sourceOriginId?: string;
	/** Torrent-file provenance; never the media path used by linking. */
	torrentFilePath?: string;
	/**
	 * If searchee is torrent based, !infoHash && !path for virtual
	 */
	infoHash?: string;
	/**
	 * If searchee is data based, !infoHash && !path for virtual
	 */
	path?: string;
	files: File[];
	/**
	 * Original name. Use when interacting with path on disk or client logging
	 * e.g. during the action stage for sourceRoot
	 */
	name: string;
	/**
	 * Usually name but can differ if we can parse something better.
	 * e.g. Season 7 -> Show S7
	 */
	title: string;
	length: number;
	mtimeMs?: number;
	clientHost?: string;
	savePath?: string;
	category?: string;
	tags?: string[];
	trackers?: string[];
	label?: SearcheeLabel;
}

export type SearcheeWithInfoHash = WithRequired<Searchee, "infoHash">;
export type SearcheeWithoutInfoHash = WithUndefined<Searchee, "infoHash">;
export type SearcheeClient = WithRequired<
	Searchee,
	"infoHash" | "clientHost" | "savePath" | "trackers"
>;
export type SearcheeVirtual = WithUndefined<Searchee, "infoHash" | "path">;
export type SearcheeWithLabel = WithRequired<Searchee, "label">;

export function hasInfoHash(
	searchee: Searchee,
): searchee is SearcheeWithInfoHash {
	return searchee.infoHash != null;
}

export enum SearcheeSource {
	CLIENT = "torrentClient",
	TORRENT = "torrentFile",
	DATA = "dataDir",
	VIRTUAL = "virtual",
}

export function getSearcheeSource(searchee: Searchee): SearcheeSource {
	if (searchee.savePath) {
		return SearcheeSource.CLIENT;
	} else if (searchee.infoHash) {
		return SearcheeSource.TORRENT;
	} else if (searchee.path) {
		return SearcheeSource.DATA;
	} else {
		return SearcheeSource.VIRTUAL;
	}
}

export function getMediaType({ title, files }: Searchee): MediaType {
	switch (true /* eslint-disable no-fallthrough */) {
		case EP_REGEX.test(title):
			return MediaType.EPISODE;
		case SEASON_REGEX.test(title):
			return MediaType.SEASON;
		case hasExt(files, VIDEO_EXTENSIONS):
			if (MOVIE_REGEX.test(title)) return MediaType.MOVIE;
			if (ANIME_REGEX.test(title)) return MediaType.ANIME;
			return MediaType.VIDEO;
		case hasExt(files, VIDEO_DISC_EXTENSIONS):
			if (MOVIE_REGEX.test(title)) return MediaType.MOVIE;
			return MediaType.VIDEO;
		case hasExt(files, [".rar"]):
			if (MOVIE_REGEX.test(title)) return MediaType.MOVIE;
		default: // Minimally supported media types
			if (hasExt(files, AUDIO_EXTENSIONS)) return MediaType.AUDIO;
			if (hasExt(files, BOOK_EXTENSIONS)) return MediaType.BOOK;
			return MediaType.OTHER;
	}
}

export function getFuzzySizeFactor(searchee: Searchee): number {
	const { fuzzySizeThreshold, seasonFromEpisodes } = getRuntimeConfig();
	return seasonFromEpisodes && !searchee.infoHash && !searchee.path
		? 1 - seasonFromEpisodes
		: fuzzySizeThreshold;
}

export function getMinSizeRatio(searchee: Searchee): number {
	const { fuzzySizeThreshold, seasonFromEpisodes } = getRuntimeConfig();
	return seasonFromEpisodes && !searchee.infoHash && !searchee.path
		? seasonFromEpisodes
		: 1 - fuzzySizeThreshold;
}

export function getRoot(
	{ path }: File,
	options = { dirname, isAbsolute },
): Result<string, Error> {
	if (
		options.isAbsolute(path) ||
		path.startsWith("/") ||
		ABS_WIN_PATH_REGEX.test(path)
	) {
		return resultOfErr(
			new Error(
				`absolute paths for the torrent file tree are not supported. File tree paths must be relative to the torrent save path: ${path}`,
			),
		);
	}
	let root = path;
	let parent = options.dirname(root);
	while (parent !== ".") {
		root = parent;
		parent = options.dirname(root);
	}
	return resultOf(root);
}

export function getRootFolder(file: File): Result<string | null, Error> {
	const res = getRoot(file);
	if (res.isErr()) return res;
	const root = res.unwrap();
	if (root === file.path) return resultOf(null);
	return resultOf(root);
}

export function getLargestFile(files: File[]): File {
	return files.reduce((a, b) => (a.length > b.length ? a : b));
}

export async function getNewestFileAge(
	absoluteFilePaths: string[],
): Promise<number> {
	return (
		await mapAsync(absoluteFilePaths, async (f) => (await stat(f)).mtimeMs)
	).reduce((a, b) => Math.max(a, b));
}

export async function getSearcheeNewestFileAge(
	searchee: SearcheeWithoutInfoHash,
): Promise<number> {
	const { path } = searchee;
	if (!path) {
		return getNewestFileAge(searchee.files.map((file) => file.path));
	}
	const pathStat = await stat(path);
	if (pathStat.isFile()) return pathStat.mtimeMs;
	return getNewestFileAge(
		searchee.files.map((file) => join(dirname(path), file.path)),
	);
}

async function getFileNamesFromRootRec(
	root: string,
	memoizedPaths: Map<string, string[]>,
	isDirHint?: boolean,
): Promise<string[]> {
	if (memoizedPaths.has(root)) return memoizedPaths.get(root)!;
	const isDir =
		isDirHint !== undefined ? isDirHint : (await stat(root)).isDirectory();
	const paths = !isDir
		? [root]
		: await flatMapAsync(
				await readdir(root, { withFileTypes: true }),
				(dirent) =>
					getFileNamesFromRootRec(
						join(root, dirent.name),
						memoizedPaths,
						dirent.isDirectory(),
					),
			);
	memoizedPaths.set(root, paths);
	return paths;
}

export async function getFilesFromDataRoot(
	rootPath: string,
	memoizedPaths: Map<string, string[]>,
	memoizedLengths: Map<string, number>,
): Promise<File[]> {
	const parentDir = dirname(rootPath);
	try {
		return await mapAsync(
			await getFileNamesFromRootRec(rootPath, memoizedPaths),
			async (file) => ({
				path: relative(parentDir, file),
				name: basename(file),
				length:
					memoizedLengths.get(file) ??
					memoizedLengths
						.set(file, (await stat(file)).size)
						.get(file)!,
			}),
		);
	} catch (e) {
		logger.debug(e);
		return [];
	}
}

/**
 * Parse things like the resolution to add to parsed titles for better decisions.
 * @param videoFileNames All relavant video file names (e.g episodes for a season)
 * @returns Info to add to the title if all files match
 */
function parseMetaInfo(videoFileNames: string[]): string {
	let metaInfo = "";
	const videoStems = videoFileNames.map((name) => stripExtension(name));
	const types = videoStems
		.map((stem) => stem.match(REPACK_PROPER_REGEX)?.groups?.type)
		.filter(isTruthy);
	if (types.length) {
		metaInfo += ` REPACK`;
	}
	const res = videoStems
		.map((stem) =>
			stem.match(RES_STRICT_REGEX)?.groups?.res?.trim()?.toLowerCase(),
		)
		.filter(isTruthy);
	if (res.length === videoStems.length && res.every((r) => r === res[0])) {
		metaInfo += ` ${res[0]}`;
	}
	const sources = videoStems
		.map((stem) => parseSource(stem))
		.filter(isTruthy);
	if (
		sources.length === videoStems.length &&
		sources.every((s) => s === sources[0])
	) {
		metaInfo += ` ${sources[0]}`;
	}
	const groups = videoStems
		.map((stem) => getReleaseGroup(stem))
		.filter(isTruthy);
	if (
		groups.length === videoStems.length &&
		groups.every((g) => g.toLowerCase() === groups[0].toLowerCase())
	) {
		metaInfo += `-${groups[0]}`;
	}
	return metaInfo;
}

/**
 * Parse title from SXX or Season XX. Return null if no title found.
 * Also tries to parse titles that are just `Show`, returns `Show` if better not found.
 * @param name Original name of the searchee/metafile
 * @param files files in the searchee
 * @param path if data based, the path to the searchee
 */
export function parseTitle(
	name: string,
	files: File[],
	path?: string,
): string | null {
	const seasonMatch =
		name.length < 12 ? name.match(SONARR_SUBFOLDERS_REGEX) : null;
	if (
		!seasonMatch &&
		(name.match(/\d/) || !hasExt(files, VIDEO_EXTENSIONS))
	) {
		return name;
	}

	const videoFiles = filesWithExt(files, VIDEO_EXTENSIONS);
	for (const videoFile of videoFiles) {
		const ep = videoFile.name.match(EP_REGEX);
		if (ep) {
			const seasonVal =
				ep.groups!.season ??
				ep.groups!.year ??
				seasonMatch?.groups!.seasonNum;
			const season = seasonVal ? `S${extractInt(seasonVal)}` : "";
			const episode =
				videoFiles.length === 1
					? `E${ep.groups!.episode ? extractInt(ep.groups!.episode) : `${ep.groups!.month}.${ep.groups!.day}`}`
					: "";
			if (season.length || episode.length || !seasonMatch) {
				const metaInfo = parseMetaInfo(videoFiles.map((f) => f.name));
				return `${ep.groups!.title} ${season}${episode}${metaInfo}`.trim();
			}
		}
		if (path && seasonMatch) {
			const title = basename(dirname(path)).match(ARR_DIR_REGEX)?.groups
				?.title;
			if (title?.length) {
				const metaInfo = parseMetaInfo(videoFiles.map((f) => f.name));
				return `${title} S${seasonMatch.groups!.seasonNum}${metaInfo}`;
			}
		}
		const anime = videoFile.name.match(ANIME_REGEX);
		if (anime) {
			const season = seasonMatch
				? `S${seasonMatch.groups!.seasonNum}`
				: "";
			if (season.length || !seasonMatch) {
				const metaInfo = parseMetaInfo(videoFiles.map((f) => f.name));
				return `${anime.groups!.title} ${season}${metaInfo}`.trim();
			}
		}
	}
	return !seasonMatch ? name : null;
}

export async function updateSearcheeClientDB(
	clientHost: string,
	newSearchees: SearcheeClient[],
	infoHashes: Set<string>,
	lease?: ClientCacheLease,
	complete = true,
	aliases?: ReadonlyMap<string, readonly string[]>,
): Promise<boolean> {
	const operation = lease ?? beginClientCacheOperation(clientHost);
	try {
		if (operation.clientHost !== clientHost)
			throw new Error("Client cache lease namespace mismatch");
		// A failed metadata batch must never authorize removal of absent sources.
		const accepted = await upsertSearcheeClientDB(
			newSearchees,
			operation,
			aliases,
		);
		if (!complete) return accepted;
		const completed = await completeClientCacheSnapshot(
			operation,
			async (trx, canRemove) => {
				const locator = normalizeSourceLocator(
					"client",
					operation.sourceLocator,
				);
				const seenOrigins = new Set<string>();
				const seenKeys = new Set(infoHashes);
				await inBatches([...infoHashes], async (batch) => {
					const keys = [
						...new Set(
							batch.flatMap((hash) => [
								hash,
								...(aliases?.get(hash) ?? []),
							]),
						),
					];
					for (const key of keys) {
						seenKeys.add(key);
						canRemove(key);
					}
					const known = await trx("source_alias as seen")
						.join(
							"source_namespace as namespace",
							"seen.namespace_id",
							"namespace.id",
						)
						.join(
							"source_alias as known",
							"seen.origin_id",
							"known.origin_id",
						)
						.where({
							"namespace.type": "client",
							"namespace.locator": locator,
						})
						.whereIn("seen.alias", keys)
						.select<{ origin_id: string; alias: string }[]>(
							"known.origin_id",
							"known.alias",
						);
					for (const row of known) {
						seenOrigins.add(row.origin_id);
						seenKeys.add(row.alias);
						canRemove(row.alias);
					}
				});
				const namespaceRow = await trx<{
					id: string;
					type: string;
					locator: string;
				}>("source_namespace")
					.where({ type: "client", locator })
					.first();
				const namespace = namespaceRow?.id;
				const rows = await trx<{
					info_hash: string;
					source_namespace_id: string | null;
				}>("client_searchee")
					.where("client_host", clientHost)
					.select("info_hash", "source_namespace_id");
				const otherOwned = new Set(
					rows
						.filter(
							(row) =>
								row.source_namespace_id !== null &&
								row.source_namespace_id !== namespace,
						)
						.map((row) => row.info_hash),
				);
				const removed = new Set(
					rows
						.filter(
							(row) =>
								!otherOwned.has(row.info_hash) &&
								!seenKeys.has(row.info_hash) &&
								canRemove(row.info_hash),
						)
						.map((row) => row.info_hash),
				);
				// A first validated inventory also reconciles named migrated sources.
				// Unknown hosts and rows owned by another endpoint retain their provenance.
				const legacy = await trx("source_origin")
					.where({
						namespace_id: "legacy-unknown",
						state: "legacy-unknown",
					})
					.whereRaw(
						"json_extract(metadata, '$.clientHost') = ? AND json_type(metadata, '$.infoHash') = 'text'",
						[clientHost],
					)
					.select<
						{ id: string; revision: number; info_hash: string }[]
					>(
						"id",
						"revision",
						trx.raw(
							"json_extract(metadata, '$.infoHash') AS info_hash",
						),
					);
				for (const origin of legacy) {
					if (
						!origin.info_hash ||
						otherOwned.has(origin.info_hash) ||
						seenKeys.has(origin.info_hash) ||
						!canRemove(origin.info_hash)
					)
						continue;
					if (
						!(await tombstoneSourceOrigin(
							trx,
							origin.id,
							origin.revision,
							origin.revision + 1,
						))
					)
						throw new Error(
							"Client source removal revision conflict",
						);
					removed.add(origin.info_hash);
				}
				if (namespace) {
					await inBatches([...removed], async (batch) => {
						const origins = await trx("source_alias as alias")
							.join(
								"source_origin as origin",
								"alias.origin_id",
								"origin.id",
							)
							.where("alias.namespace_id", namespace)
							.whereIn("alias.alias", batch)
							.distinct<
								{ id: string; revision: number }[]
							>("origin.id", "origin.revision");
						for (const origin of origins) {
							if (
								!seenOrigins.has(origin.id) &&
								!(await tombstoneSourceOrigin(
									trx,
									origin.id,
									origin.revision,
									origin.revision + 1,
								))
							)
								throw new Error(
									"Client source removal revision conflict",
								);
						}
					});
				}
				const removedHashes = [...removed];
				// Complete removals share one transaction: metadata cannot disappear while
				// its membership deletion fails, even at a later SQL batch.
				await inBatches(removedHashes, async (batch) => {
					await trx("client_searchee")
						.whereIn("info_hash", batch)
						.where("client_host", clientHost)
						.del();
					await trx("ensemble")
						.whereIn("info_hash", batch)
						.where("client_host", clientHost)
						.del();
				});
				return removedHashes;
			},
		);
		return accepted && completed;
	} finally {
		if (!lease) releaseClientCacheOperation(operation);
	}
}

/** Update scoped metadata without reconciling a complete client snapshot. */
export async function upsertSearcheeClientDB(
	newSearchees: SearcheeClient[],
	lease?: ClientCacheLease,
	aliases?: ReadonlyMap<string, readonly string[]>,
): Promise<boolean> {
	const leases = new Map<string, ClientCacheLease>();
	for (const searchee of newSearchees) {
		if (lease && lease.clientHost !== searchee.clientHost)
			throw new Error("Client cache lease namespace mismatch");
		if (!leases.has(searchee.clientHost))
			leases.set(
				searchee.clientHost,
				lease ?? beginClientCacheOperation(searchee.clientHost),
			);
	}
	try {
		let accepted = true;
		for (const [host, operation] of leases) {
			await inBatches(
				newSearchees.filter((s) => s.clientHost === host),
				async (batch) => {
					// Bind ordering to persisted origin equivalence even when an older client
					// omits v1/v2 fields after a coordinator restart.
					const knownAliases = new Map<string, string[]>(
						batch.map((source) => [
							source.infoHash,
							[
								source.infoHash,
								...(aliases?.get(source.infoHash) ?? []),
							],
						]),
					);
					const keys = [
						...new Set([...knownAliases.values()].flat()),
					];
					const bound = await db("source_alias as requested")
						.join(
							"source_namespace as namespace",
							"requested.namespace_id",
							"namespace.id",
						)
						.join(
							"source_alias as known",
							"requested.origin_id",
							"known.origin_id",
						)
						.where({
							"namespace.type": "client",
							"namespace.locator": normalizeSourceLocator(
								"client",
								operation.sourceLocator,
							),
						})
						.whereIn("requested.alias", keys)
						.select<{ requested: string; alias: string }[]>(
							"requested.alias as requested",
							"known.alias as alias",
						);
					for (const [key, group] of knownAliases) {
						knownAliases.set(key, [
							...new Set([
								...group,
								...bound
									.filter((row) =>
										group.includes(row.requested),
									)
									.map((row) => row.alias),
							]),
						]);
					}
					const published = await publishClientCacheBatch(
						operation,
						batch.map((s) => s.infoHash),
						async (trx, keys) => {
							const namespace = await ensureSourceNamespace(
								trx,
								"client",
								operation.sourceLocator,
							);
							const rows = batch
								.filter((s) => keys.has(s.infoHash))
								.map((searchee) => ({
									info_hash: searchee.infoHash,
									name: searchee.name,
									title: searchee.title,
									files: JSON.stringify(searchee.files),
									length: searchee.length,
									client_host: searchee.clientHost,
									source_namespace_id: namespace,
									save_path: searchee.savePath,
									category: searchee.category ?? null,
									tags: searchee.tags
										? JSON.stringify(searchee.tags)
										: null,
									trackers: JSON.stringify(searchee.trackers),
								}));
							await trx("client_searchee")
								.insert(rows)
								.onConflict(["client_host", "info_hash"])
								.merge();
							for (const searchee of batch.filter((source) =>
								keys.has(source.infoHash),
							)) {
								const origin = await resolveSourceOrigin(
									trx,
									namespace,
									searchee.infoHash,
									[
										...(aliases?.get(searchee.infoHash) ??
											[]),
									],
									{
										authoritativeAliases: Boolean(
											aliases?.get(searchee.infoHash)
												?.length,
										),
									},
								);
								const pieces = getRuntimeConfig()
									.seasonFromEpisodes
									? createEnsemblePieces(
											searchee.title,
											searchee.files,
										)
									: null;
								const published =
									await replaceSourcePublication(trx, {
										originId: origin.id,
										expectedRevision: origin.revision,
										revision: origin.revision + 1,
										metadata: searchee,
										status: "verified",
										memberships:
											pieces?.map((piece) => ({
												path: join(
													searchee.savePath,
													piece.largestFile.path,
												),
												ensemble: piece.key,
												element: normalizeSourceElement(
													piece.element,
												),
											})) ?? [],
									});
								if (!published)
									throw new Error(
										"Client source publication revision conflict",
									);
							}
						},
						knownAliases,
					);
					accepted &&= published;
					if (published) await setImmediate();
				},
			);
		}
		return accepted;
	} finally {
		if (!lease)
			for (const operation of leases.values())
				releaseClientCacheOperation(operation);
	}
}

export interface ClientSearcheeRow {
	source_namespace_id?: string | null;
	info_hash: string;
	name: string;
	title: string;
	files: string;
	length: number;
	client_host: string;
	save_path: string;
	category?: string | null;
	tags?: string | null;
	trackers: string;
}

export function createSearcheeFromDB(
	dbTorrent: ClientSearcheeRow,
): SearcheeClient {
	return {
		infoHash: dbTorrent.info_hash,
		name: dbTorrent.name,
		title: dbTorrent.title,
		files: JSON.parse(dbTorrent.files) as File[],
		length: dbTorrent.length,
		clientHost: dbTorrent.client_host,
		savePath: dbTorrent.save_path,
		category: dbTorrent.category ?? undefined,
		tags: dbTorrent.tags
			? (JSON.parse(dbTorrent.tags) as string[])
			: undefined,
		trackers: JSON.parse(dbTorrent.trackers) as string[],
	};
}

export function createSearcheeFromMetafile(
	meta: Metafile,
): Result<SearcheeWithInfoHash, Error> {
	const title = parseTitle(meta.name, meta.files);
	if (title) {
		return resultOf({
			files: meta.files,
			infoHash: meta.infoHash,
			name: meta.name,
			title,
			length: meta.length,
			category: meta.category,
			tags: meta.tags,
			trackers: meta.trackers,
		});
	}
	const msg = `Could not find title for ${getLogString(meta)} from child files`;
	logger.verbose({
		label: Label.PREFILTER,
		message: msg,
	});
	return resultOfErr(new Error(msg));
}

export async function createSearcheeFromTorrentFile(
	filePath: string,
	torrentInfos: TorrentMetadataInClient[],
): Promise<Result<SearcheeWithInfoHash, Error>> {
	try {
		const meta = await parseTorrentWithMetadata(filePath, torrentInfos);
		return createSearcheeFromMetafile(meta);
	} catch (e) {
		logger.error({
			label: Label.INDEX,
			message: `Failed to parse ${basename(filePath)}: ${errorMessage(e)}`,
		});
		logger.debug(e);
		return resultOfErr(e);
	}
}

export async function createSearcheeFromPath(
	root: string,
	memoizedPaths = new Map<string, string[]>(),
	memoizedLengths = new Map<string, number>(),
): Promise<Result<SearcheeWithoutInfoHash, Error>> {
	const files = await getFilesFromDataRoot(
		root,
		memoizedPaths,
		memoizedLengths,
	);
	if (files.length === 0) {
		const msg = `Failed to retrieve files in ${root}`;
		logger.verbose({
			label: Label.PREFILTER,
			message: msg,
		});
		return resultOfErr(new Error(msg));
	}
	const totalLength = files.reduce(
		(runningTotal, file) => runningTotal + file.length,
		0,
	);

	const name = basename(root);
	const title = parseTitle(name, files, root);
	if (title) {
		const searchee: SearcheeWithoutInfoHash = {
			infoHash: undefined,
			path: root,
			files: files,
			name,
			title,
			length: totalLength,
		};
		searchee.mtimeMs = await getSearcheeNewestFileAge(searchee);
		return resultOf(searchee);
	}
	const msg = `Could not find title for ${root} in parent directory or child files`;
	logger.verbose({
		label: Label.PREFILTER,
		message: msg,
	});
	return resultOfErr(new Error(msg));
}

export function getAllTitles(titles: string[]): string[] {
	const allTitles = titles.slice();
	for (const title of titles) {
		if (AKA_REGEX.test(title) && title.trim().toLowerCase() !== "aka") {
			allTitles.push(...title.split(AKA_REGEX));
		}
	}
	return allTitles;
}

export function getMovieKeys(stem: string): {
	ensembleTitles: string[];
	keyTitles: string[];
	year: number;
} | null {
	const match = stem.match(MOVIE_REGEX);
	if (!match) return null;
	const titles = getAllTitles([match.groups!.title]);
	const year = extractInt(match.groups!.year);
	const keyTitles: string[] = [];
	const ensembleTitles: string[] = [];
	for (const title of titles) {
		const keyTitle = createKeyTitle(title);
		if (!keyTitle) continue;
		keyTitles.push(keyTitle);
		ensembleTitles.push(`${title}.${year}`);
	}
	if (!keyTitles.length) return null;
	return { ensembleTitles, keyTitles, year };
}

export function getSeasonKeys(stem: string): {
	ensembleTitles: string[];
	keyTitles: string[];
	season: string;
} | null {
	const match = stem.match(SEASON_REGEX);
	if (!match) return null;
	const titles = getAllTitles([match.groups!.title]);
	const season = `S${extractInt(match.groups!.season)}`;
	const keyTitles: string[] = [];
	const ensembleTitles: string[] = [];
	for (const title of titles) {
		const keyTitle = createKeyTitle(title);
		if (!keyTitle) continue;
		keyTitles.push(keyTitle);
		ensembleTitles.push(`${title}.${season}`);
	}
	if (!keyTitles.length) return null;
	return { ensembleTitles, keyTitles, season };
}

export function getEpisodeKeys(stem: string): {
	ensembleTitles: string[];
	keyTitles: string[];
	season: string | undefined;
	episode: number | string;
} | null {
	const match = stem.match(EP_REGEX);
	if (!match) return null;
	const titles = getAllTitles([match.groups!.title]);
	const season = match.groups!.season
		? `S${extractInt(match.groups!.season)}`
		: match.groups!.year
			? `S${match.groups!.year}`
			: undefined;
	const keyTitles: string[] = [];
	const ensembleTitles: string[] = [];
	for (const title of titles) {
		const keyTitle = createKeyTitle(title);
		if (!keyTitle) continue;
		keyTitles.push(keyTitle);
		ensembleTitles.push(`${title}${season ? `.${season}` : ""}`);
	}
	if (!keyTitles.length) return null;
	const episode = match.groups!.episode
		? extractInt(match.groups!.episode)
		: `${match.groups!.month}.${match.groups!.day}`;
	return { ensembleTitles, keyTitles, season, episode };
}

export function getAnimeKeys(stem: string): {
	ensembleTitles: string[];
	keyTitles: string[];
	release: number;
} | null {
	const match = stem.match(ANIME_REGEX);
	if (!match) return null;
	const titles = getAllTitles([match.groups!.title, match.groups!.altTitle]);
	const keyTitles: string[] = [];
	const ensembleTitles: string[] = [];
	for (const title of titles) {
		if (!title) continue;
		if (isBadTitle(title)) continue;
		const keyTitle = createKeyTitle(title);
		if (!keyTitle) continue;
		keyTitles.push(keyTitle);
		ensembleTitles.push(title);
	}
	if (!keyTitles.length) return null;
	const release = extractInt(match.groups!.release);
	return { ensembleTitles, keyTitles, release };
}

export function getReleaseGroup(stem: string): string | null {
	const predictedGroupMatch = stem.match(RELEASE_GROUP_REGEX);
	if (!predictedGroupMatch) {
		return null;
	}
	const parsedGroupMatchString = predictedGroupMatch.groups!.group.trim();
	if (BAD_GROUP_PARSE_REGEX.test(parsedGroupMatchString)) return null;
	const match =
		stem.match(EP_REGEX) ??
		stem.match(SEASON_REGEX) ??
		stem.match(MOVIE_REGEX) ??
		stem.match(ANIME_REGEX);
	const titles = getAllTitles(
		[match?.groups?.title, match?.groups?.altTitle].filter(isTruthy),
	);
	for (const title of titles) {
		const group = title.match(RELEASE_GROUP_REGEX)?.groups!.group.trim();
		if (group && parsedGroupMatchString.includes(group)) return null;
	}
	return parsedGroupMatchString;
}

export function getKeyMetaInfo(stem: string): string {
	const resM = stem.match(RES_STRICT_REGEX)?.groups?.res;
	const res = resM ? `.${resM}` : "";
	const sourceM = parseSource(stem);
	const source = sourceM ? `.${sourceM}` : "";
	const groupM = getReleaseGroup(stem);
	if (groupM) {
		return `${res}${source}-${groupM}`.toLowerCase();
	}
	const groupAnimeM = stem.match(ANIME_GROUP_REGEX)?.groups?.group;
	if (groupAnimeM) {
		return `${res}${source}-${groupAnimeM}`.toLowerCase();
	}
	return `${res}${source}`.toLowerCase();
}

const logEnsemble = (
	reason: string,
	searcheeLabel: SearcheeLabel,
	options: { useFilters: boolean },
): void => {
	if (!options.useFilters) return;
	logger.verbose({
		label: `${searcheeLabel}/${Label.PREFILTER}`,
		message: reason,
	});
};

function parseEnsembleKeys(
	searchee: SearcheeWithLabel,
	keys: string[],
	ensembleTitles: string[],
	episode: number | string,
	existingSeasonMap: Map<string, SearcheeWithLabel[]>,
	keyMap: Map<string, Map<number | string, SearcheeWithLabel[]>>,
	ensembleTitleMap: Map<string, string>,
): void {
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (existingSeasonMap.has(key)) continue;
		if (!ensembleTitleMap.has(key)) {
			ensembleTitleMap.set(key, ensembleTitles[i]);
		}
		const episodesMap = keyMap.get(key);
		if (!episodesMap) {
			keyMap.set(key, new Map([[episode, [searchee]]]));
			continue;
		}
		const episodeSearchees = episodesMap.get(episode);
		if (!episodeSearchees) {
			episodesMap.set(episode, [searchee]);
			continue;
		}
		episodeSearchees.push(searchee);
	}
}

/**
 * Organize episodes by {key: {episode: [searchee]}}
 */
function organizeEnsembleKeys(
	allSearchees: SearcheeWithLabel[],
	options: { useFilters: boolean },
): {
	keyMap: Map<string, Map<number | string, SearcheeWithLabel[]>>;
	ensembleTitleMap: Map<string, string>;
} {
	const existingSeasonMap = new Map<string, SearcheeWithLabel[]>();
	if (options.useFilters) {
		for (const searchee of allSearchees) {
			const stem = stripExtension(searchee.title);
			const seasonKeys = getSeasonKeys(stem);
			if (!seasonKeys) continue;
			const info = getKeyMetaInfo(stem);
			const keys = seasonKeys.keyTitles.map(
				(k) => `${k}.${seasonKeys.season}${info}`,
			);
			for (const key of keys) {
				if (!existingSeasonMap.has(key)) existingSeasonMap.set(key, []);
				existingSeasonMap.get(key)!.push(searchee);
			}
		}
	}
	const keyMap = new Map<string, Map<number | string, SearcheeWithLabel[]>>();
	const ensembleTitleMap = new Map<string, string>();
	for (const searchee of allSearchees) {
		const stem = stripExtension(searchee.title);
		const episodeKeys = getEpisodeKeys(stem);
		if (episodeKeys) {
			const info = getKeyMetaInfo(stem);
			const keys = episodeKeys.keyTitles.map(
				(k) =>
					`${k}${episodeKeys.season ? `.${episodeKeys.season}` : ""}${info}`,
			);
			const ensembleTitles = episodeKeys.ensembleTitles.map(
				(t) => `${t}${info}`,
			);
			parseEnsembleKeys(
				searchee,
				keys,
				ensembleTitles,
				episodeKeys.episode,
				existingSeasonMap,
				keyMap,
				ensembleTitleMap,
			);
			if (options.useFilters) continue;
		}
		if (options.useFilters && SEASON_REGEX.test(stem)) continue;
		if (!hasExt(searchee.files, VIDEO_EXTENSIONS)) continue; // Anime regex matching is too loose
		const animeKeys = getAnimeKeys(stem);
		if (animeKeys) {
			const info = getKeyMetaInfo(stem);
			const keys = animeKeys.keyTitles.map((k) => `${k}${info}`);
			const ensembleTitles = animeKeys.ensembleTitles.map(
				(t) => `${t}${info}`,
			);
			parseEnsembleKeys(
				searchee,
				keys,
				ensembleTitles,
				animeKeys.release,
				existingSeasonMap,
				keyMap,
				ensembleTitleMap,
			);
			if (options.useFilters) continue;
		}
	}
	return { keyMap, ensembleTitleMap };
}

async function pushEnsembleEpisode(
	searchee: SearcheeWithLabel,
	episodeFiles: File[],
	hosts: Map<string, number>,
	torrentSavePaths: Map<string, string>,
): Promise<void> {
	const savePath = searchee.path
		? dirname(searchee.path)
		: (searchee.savePath ?? torrentSavePaths.get(searchee.infoHash!));
	if (!savePath) return;
	const largestFile = getLargestFile(searchee.files);
	if (largestFile.length / searchee.length < 0.5) return;
	const absoluteFile: File = {
		length: largestFile.length,
		name: largestFile.name,
		path: join(savePath, largestFile.path),
	};
	if (await notExists(absoluteFile.path)) return;

	// Use the oldest file for episode if dupe (cross seeds)
	const duplicateFile = episodeFiles.find(
		(file) => file.length === absoluteFile.length,
	);
	if (duplicateFile) {
		const dupeFileAge = (await stat(duplicateFile.path)).mtimeMs;
		const newFileAge = (await stat(absoluteFile.path)).mtimeMs;
		if (dupeFileAge <= newFileAge) return;
		episodeFiles.splice(episodeFiles.indexOf(duplicateFile), 1);
	}
	episodeFiles.push(absoluteFile);
	const clientHost = searchee.clientHost;
	if (clientHost) hosts.set(clientHost, (hosts.get(clientHost) ?? 0) + 1);
}

async function createVirtualSeasonSearchee(
	key: string,
	episodeSearchees: Map<string | number, SearcheeWithLabel[]>,
	ensembleTitleMap: Map<string, string>,
	torrentSavePaths: Map<string, string>,
	searcheeLabel: SearcheeLabel,
	options: { useFilters: boolean },
): Promise<SearcheeWithLabel | null> {
	const seasonFromEpisodes = getRuntimeConfig().seasonFromEpisodes!;
	const minEpisodes = 3;
	if (options.useFilters && episodeSearchees.size < minEpisodes) {
		return null;
	}
	const ensembleTitle = ensembleTitleMap.get(key)!;
	const episodes = Array.from(episodeSearchees.keys());
	if (typeof episodes[0] === "number") {
		const highestEpisode = Math.max(...(episodes as number[]));
		const availPct = episodes.length / highestEpisode;
		if (options.useFilters && availPct < seasonFromEpisodes) {
			logEnsemble(
				`Skipping virtual searchee for ${ensembleTitle} episodes as there's only ${episodes.length}/${highestEpisode} (${availPct.toFixed(2)} < ${seasonFromEpisodes.toFixed(2)})`,
				searcheeLabel,
				options,
			);
			return null;
		}
	}
	const seasonSearchee: SearcheeWithLabel = {
		name: ensembleTitle,
		title: ensembleTitle,
		files: [], // Can have multiple files per episode
		length: 0, // Total length of episodes (uses average for multi-file episodes)
		label: searcheeLabel,
	};
	let newestFileAge = 0;
	const hosts = new Map<string, number>();
	for (const [, searchees] of episodeSearchees) {
		const episodeFiles: File[] = [];
		for (const searchee of searchees) {
			await pushEnsembleEpisode(
				searchee,
				episodeFiles,
				hosts,
				torrentSavePaths,
			);
		}
		if (episodeFiles.length === 0) continue;
		const total = episodeFiles.reduce((a, b) => a + b.length, 0);
		seasonSearchee.length += Math.round(total / episodeFiles.length);
		seasonSearchee.files.push(...episodeFiles);
		const fileAges = await mapAsync(
			episodeFiles,
			async (f) => (await stat(f.path)).mtimeMs,
		);
		newestFileAge = Math.max(newestFileAge, ...fileAges);
	}
	seasonSearchee.mtimeMs = newestFileAge;
	seasonSearchee.clientHost = [...hosts].sort(
		comparing(
			(host) => -host[1],
			(host) => byClientHostPriority(host[0]),
		),
	)[0]?.[0];
	if (seasonSearchee.files.length < minEpisodes) {
		logEnsemble(
			`Skipping virtual searchee for ${ensembleTitle} episodes as only ${seasonSearchee.files.length} episode files were found (min: ${minEpisodes})`,
			searcheeLabel,
			options,
		);
		return null;
	}
	if (options.useFilters && Date.now() - newestFileAge < ms("8 days")) {
		logEnsemble(
			`Skipping virtual searchee for ${ensembleTitle} episodes as some are below the minimum age of 8 days: ${humanReadableDate(newestFileAge)}`,
			searcheeLabel,
			options,
		);
		return null;
	}
	logEnsemble(
		`Created virtual searchee for ${ensembleTitle}: ${episodeSearchees.size} episodes - ${seasonSearchee.files.length} files - ${humanReadableSize(seasonSearchee.length)}`,
		searcheeLabel,
		options,
	);
	return seasonSearchee;
}

export async function createEnsembleSearchees(
	allSearchees: SearcheeWithLabel[],
	options: { useFilters: boolean },
): Promise<SearcheeWithLabel[]> {
	return withMutex(
		Mutex.CREATE_ALL_SEARCHEES,
		{ useQueue: true },
		async () => {
			const { seasonFromEpisodes, useClientTorrents } =
				getRuntimeConfig();
			if (!allSearchees.length) return [];
			if (!seasonFromEpisodes) return [];
			const searcheeLabel = allSearchees[0].label;
			if (options.useFilters) {
				logger.info({
					label: searcheeLabel,
					message: `Creating virtual seasons from episode searchees...`,
				});
			}

			const { keyMap, ensembleTitleMap } = organizeEnsembleKeys(
				allSearchees,
				options,
			);
			const torrentSavePaths: Map<string, string> = useClientTorrents
				? new Map<string, string>()
				: ((await getClients()[0]?.getAllDownloadDirs({
						metas: allSearchees.filter(
							hasInfoHash,
						) as SearcheeWithInfoHash[],
						onlyCompleted: false,
					})) ?? new Map<string, string>());

			const seasonSearchees: SearcheeWithLabel[] = [];
			for (const [key, episodeSearchees] of keyMap) {
				const seasonSearchee = await createVirtualSeasonSearchee(
					key,
					episodeSearchees,
					ensembleTitleMap,
					torrentSavePaths,
					searcheeLabel,
					options,
				);
				if (seasonSearchee) seasonSearchees.push(seasonSearchee);
			}
			logEnsemble(
				`Created ${seasonSearchees.length} virtual season searchees...`,
				searcheeLabel,
				options,
			);

			return seasonSearchees;
		},
	);
}

export async function collectSearcheeProblems(): Promise<Problem[]> {
	const { useClientTorrents, torrentDir, dataDirs } = getRuntimeConfig();
	const expectsSearchees =
		Boolean(useClientTorrents) ||
		Boolean(torrentDir) ||
		(Array.isArray(dataDirs) && dataDirs.length > 0);

	if (!expectsSearchees) {
		return [];
	}

	const [{ count }] = await db("searchee").count<{ count: string }>({
		count: "*",
	});
	const total = Number(count ?? 0);
	if (total > 0) return [];

	return [
		{
			id: "searchees:none-indexed",
			severity: "warning",
			summary: "No searchees have been indexed yet.",
			details:
				"cross-seed has not indexed any torrents. Check that the indexing job succeeds and that torrentDir, useClientTorrents, or dataDirs are configured correctly.",
			metadata: {
				useClientTorrents,
				torrentDir: torrentDir ?? null,
				dataDirsCount: dataDirs?.length ?? 0,
			},
		},
	];
}
