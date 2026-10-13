import type { Knex } from "knex";
import { writeEnsembleTorrentEntries } from "./ensembleWriter.js";
import { distance } from "fastest-levenshtein";
import bencode from "bencode";
import { readdir, readFile, stat } from "fs/promises";
import { extname, join, resolve, relative } from "path";
import { inspect } from "util";
import {
	getClients,
	TorrentMetadataInClient,
} from "./clients/TorrentClient.js";
import {
	ALL_PARENTHESES_REGEX,
	ALL_SPACES_REGEX,
	ALL_SQUARE_BRACKETS_REGEX,
	LEVENSHTEIN_DIVISOR,
	MAX_PATH_BYTES,
	MediaType,
	MIN_VIDEO_QUERY_LENGTH,
	SAVED_TORRENTS_INFO_REGEX,
	USER_AGENT,
} from "./constants.js";
import {
	getDataByFuzzyName,
	enabledDataEntriesQuery,
	indexDataDirs,
	shouldIgnorePathHeuristically,
} from "./dataFiles.js";
import { db } from "./db.js";
import {
	ensureSourceNamespace,
	resolveSourceOrigin,
	findSourceOrigin,
	normalizeSourceLocator,
	clientSourceLocator,
	tombstoneSourceOrigin,
	type SourceOrigin,
} from "./sourceStore.js";
import { invalidateHealth } from "./healthGeneration.js";
import {
	beginClientCacheOperation,
	completeClientCacheSnapshot,
	releaseClientCacheOperation,
	ClientCacheConcurrencyError,
} from "./clientCachePublication.js";
import { Label, logger } from "./logger.js";
import {
	Metafile,
	TorrentMetadata,
	updateMetafileMetadata,
} from "./parseTorrent.js";
import { Candidate } from "./pipeline.js";
import { isOk, Result, resultOf, resultOfErr } from "./Result.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import {
	ClientSearcheeRow,
	createSearcheeFromDB,
	createSearcheeFromPath,
	createSearcheeFromTorrentFile,
	File,
	getAnimeKeys,
	getEpisodeKeys,
	getLargestFile,
	getMovieKeys,
	getSeasonKeys,
	SearcheeLabel,
	SearcheeWithInfoHash,
	SearcheeWithoutInfoHash,
} from "./searchee.js";
import {
	createKeyTitle,
	exists,
	filterAsync,
	filterAsyncYield,
	getLogString,
	errorMessage,
	mapAsync,
	Mutex,
	notExists,
	stripExtension,
	wait,
	withMutex,
} from "./utils.js";

export interface TorrentLocator {
	infoHash?: string;
	path?: string;
}

export interface FilenameMetadata {
	mediaType: string;
	tracker: string;
	name: string;
	infoHash?: string;
	cached: boolean;
}

export enum SnatchError {
	ABORTED = "ABORTED",
	RATE_LIMITED = "RATE_LIMITED",
	MAGNET_LINK = "MAGNET_LINK",
	INVALID_CONTENTS = "INVALID_CONTENTS",
	UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

interface TorrentEntry {
	title?: string;
	name?: string;
	file_path?: string;
}

function isRecoverableTorrentDirError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "");
}

function logRecoverableTorrentDirError(
	torrentDir: string,
	error: unknown,
): void {
	const message = errorMessage(error);
	logger.warn({
		label: Label.INDEX,
		message: `Skipping torrentDir indexing for "${torrentDir}": ${message}`,
	});
	logger.debug(error);
}

export interface EnsembleEntry {
	client_host: string | null;
	path: string;
	info_hash: string | null;
	ensemble: string;
	element: string | number;
}

export async function parseTorrentFromPath(
	filePath: string,
): Promise<Metafile> {
	return Metafile.decode(await readFile(filePath));
}

export async function parseTorrentWithMetadata(
	filePath: string,
	torrentInfos: TorrentMetadataInClient[],
): Promise<Metafile> {
	const meta = await parseTorrentFromPath(filePath);
	const clients = getClients();
	if (clients[0]?.clientType === Label.QBITTORRENT) {
		const fastResumePath = filePath.replace(
			extname(filePath),
			".fastresume",
		);
		if (await exists(fastResumePath)) {
			updateMetafileMetadata(
				meta,
				bencode.decode(
					await readFile(fastResumePath),
				) as TorrentMetadata,
			);
			return meta;
		} else {
			logger.verbose(
				`No .fastresume found at ${fastResumePath} from ${filePath}, using client to get metadata without trackers`,
			);
		}
	}
	// All other clients keep trackers in their .torrent files
	// Also fallback for qBittorrent if .fastresume is missing e.g cross-seed search --torrents ...
	// Getting all trackers for qbit require individual torrent requests but we do have the first active one
	const torrentInfo = torrentInfos.find((t) => t.infoHash === meta.infoHash);
	if (torrentInfo) {
		meta.category = torrentInfo.category;
		meta.tags = torrentInfo.tags;
		if (!meta.trackers.length && torrentInfo.trackers) {
			meta.trackers = torrentInfo.trackers;
		}
	} else if (clients.length) {
		logger.verbose(
			`No torrent info found for ${meta.infoHash} from ${filePath}`,
		);
	}
	return meta;
}

function isMagnetRedirectError(error: Error): boolean {
	return (
		// node-fetch
		error.message.includes('URL scheme "magnet" is not supported.') ||
		// undici
		Boolean(
			(error.cause as Error | undefined)?.message.includes(
				"URL scheme must be a HTTP(S) scheme",
			),
		)
	);
}

async function snatchOnce(
	candidate: Candidate,
): Promise<
	| Metafile
	| { snatchError: SnatchError; retryAfterMs?: number; extra?: string }
> {
	const { snatchTimeout } = getRuntimeConfig();
	const url = candidate.link;

	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				...(candidate.cookie ? { Cookie: candidate.cookie } : {}),
				"User-Agent": USER_AGENT,
			},
			signal:
				typeof snatchTimeout === "number"
					? AbortSignal.timeout(snatchTimeout)
					: undefined,
		});
	} catch (e) {
		const errName = e instanceof Error ? e.name : "";
		if (errName === "AbortError" || errName === "TimeoutError") {
			logger.debug(`${candidate.name}: ${url}`);
			return {
				snatchError: SnatchError.ABORTED,
				extra: `snatch timed out`,
			};
		} else if (e instanceof Error && isMagnetRedirectError(e)) {
			logger.debug(`${candidate.name}: ${url}`);
			return { snatchError: SnatchError.MAGNET_LINK };
		}
		logger.debug(`${candidate.name}: ${url}`);
		logger.debug(e);
		return {
			snatchError: SnatchError.UNKNOWN_ERROR,
			extra: `failed to access`,
		};
	}

	const retryAfterSeconds = Number(response.headers.get("Retry-After"));
	const retryAfterMs = !Number.isNaN(retryAfterSeconds)
		? retryAfterSeconds * 1000
		: undefined;
	if (response.status === 429) {
		return { snatchError: SnatchError.RATE_LIMITED, retryAfterMs };
	} else if (!response.ok) {
		const responseText = await response.clone().text();
		logger.debug(
			`${candidate.name}: ${url} - Response: "${responseText.slice(0, 100)}${
				responseText.length > 100 ? "..." : ""
			}"`,
		);
		return {
			snatchError: SnatchError.UNKNOWN_ERROR,
			retryAfterMs,
			extra: `error downloading torrent - ${response.status} ${response.statusText}`,
		};
	} else if (response.headers.get("Content-Type") === "application/rss+xml") {
		const responseText = await response.clone().text();
		logger.debug(
			`${candidate.name}: ${url} - Contents: "${responseText.slice(0, 100)}${
				responseText.length > 100 ? "..." : ""
			}"`,
		);
		return { snatchError: SnatchError.INVALID_CONTENTS, retryAfterMs };
	}
	try {
		return Metafile.decode(
			Buffer.from(new Uint8Array(await response.arrayBuffer())),
		);
	} catch (e) {
		const contentType = response.headers.get("Content-Type");
		const contentLength = response.headers.get("Content-Length");
		logger.debug(
			`${candidate.name}: ${url} - Content-Type: ${contentType} - Content-Length: ${contentLength}`,
		);
		logger.debug(e);
		return { snatchError: SnatchError.INVALID_CONTENTS, retryAfterMs };
	}
}

export const snatchHistory = new Map<
	string,
	{ initialFailureAt: number; numFailures: number }
>();

export async function snatch(
	candidate: Candidate,
	label: SearcheeLabel,
	options: { retries: number; delayMs: number },
): Promise<Result<Metafile, SnatchError>> {
	const retries = Math.max(options.retries, 0);
	const retryAfterEndTime = Date.now() + retries * options.delayMs;

	let snatchError: SnatchError;
	for (let i = 0; i <= retries; i++) {
		const progress = `${i + 1}/${retries + 1}`;
		const snatchResult = await snatchOnce(candidate);
		if (snatchResult instanceof Metafile) {
			logger.verbose({
				label,
				message: `Snatched ${candidate.name} from ${candidate.tracker}${i > 0 ? ` on attempt ${progress}` : ""}`,
			});
			snatchHistory.delete(candidate.link);
			return resultOf(snatchResult);
		}
		snatchError = snatchResult.snatchError;
		if (
			snatchError === SnatchError.RATE_LIMITED ||
			snatchError === SnatchError.MAGNET_LINK
		) {
			snatchHistory.delete(candidate.link);
			return resultOfErr(snatchError);
		}
		const { extra, retryAfterMs } = snatchResult;
		let linkHistory = snatchHistory.get(candidate.link);
		if (linkHistory) {
			++linkHistory.numFailures;
		} else {
			linkHistory = { initialFailureAt: Date.now(), numFailures: 1 };
			snatchHistory.set(candidate.link, linkHistory);
		}
		let trackerHistory = snatchHistory.get(candidate.tracker);
		if (trackerHistory) {
			++trackerHistory.numFailures;
		} else {
			trackerHistory = { initialFailureAt: Date.now(), numFailures: 1 };
			snatchHistory.set(candidate.tracker, trackerHistory);
		}
		if (linkHistory.numFailures > retries + 1) {
			logger.warn({
				label,
				message: `Snatching ${candidate.name} from ${candidate.tracker} stopped after attempt ${progress}, this snatch has failed too many times recently: ${snatchError}${extra ? ` - ${extra}` : ""}`,
			});
			return resultOfErr(snatchError);
		}
		if (trackerHistory.numFailures > retries * 2 + 1) {
			logger.warn({
				label,
				message: `Snatching ${candidate.name} from ${candidate.tracker} stopped after attempt ${progress}, this tracker has failed too many times recently: ${snatchError}${extra ? ` - ${extra}` : ""}`,
			});
			return resultOfErr(snatchError);
		}
		if (retryAfterMs && Date.now() + retryAfterMs >= retryAfterEndTime) {
			logger.warn({
				label,
				message: `Snatching ${candidate.name} from ${candidate.tracker} stopped after attempt ${progress}, Retry-After of ${retryAfterMs / 1000}s exceeds timeout: ${snatchError}${extra ? ` - ${extra}` : ""}`,
			});
			return resultOfErr(snatchError);
		}
		const delayMs = Math.max(options.delayMs, retryAfterMs ?? 0);
		logger.error({
			label,
			message: `Snatch attempt ${progress} from ${candidate.tracker} for ${candidate.name} failed${i < retries ? `, retrying in ${delayMs / 1000}s` : ""}: ${snatchError}${extra ? ` - ${extra}` : ""}`,
		});
		if (i >= retries) break;
		await wait(delayMs);
	}
	return resultOfErr(snatchError!);
}

function buildTorrentSaveName(
	mediaType: MediaType,
	tracker: string,
	name: string,
	infoHash: string,
	ext: string,
): string {
	return `[${mediaType}][${tracker}]${name}[${infoHash}]${ext}`;
}

/**
 * Be sure to update parseMetadataFromFilename if changing the format
 */
export function getTorrentSavePath(
	meta: Metafile,
	mediaType: MediaType,
	tracker: string,
	dir: string,
	options: { cached: boolean },
): string {
	const fullName = stripExtension(meta.getFileSystemSafeName());
	const ext = options.cached ? ".cached.torrent" : ".torrent";
	const fullPath = join(
		dir,
		buildTorrentSaveName(mediaType, tracker, fullName, meta.infoHash, ext),
	);
	if (Buffer.byteLength(fullPath, "utf8") <= MAX_PATH_BYTES) return fullPath;

	const codePoints = Array.from(fullName);
	let currBytes = Buffer.byteLength(`${fullPath}...`, "utf8");
	let codePointsToRemove = 0;
	for (let i = codePoints.length - 1; i >= 0; i--) {
		codePointsToRemove++;
		currBytes -= Buffer.byteLength(codePoints[i], "utf8");
		if (currBytes <= MAX_PATH_BYTES) break;
	}
	const safeName = `${codePoints.slice(0, -codePointsToRemove).join("")}...`;
	const safePath = join(
		dir,
		buildTorrentSaveName(mediaType, tracker, safeName, meta.infoHash, ext),
	);
	return safePath; // Handle the error on save if it exists
}

/**
 * Depends on getTorrentSavePath format
 */
export function parseMetadataFromFilename(
	filename: string,
): Partial<FilenameMetadata> {
	const match = filename.match(SAVED_TORRENTS_INFO_REGEX);
	if (!match) {
		return {};
	}
	const mediaType = match.groups!.mediaType;
	if (!Object.values(MediaType).includes(mediaType as MediaType)) {
		return {};
	}
	const { tracker, name, infoHash, cached } = match.groups!;
	return { mediaType, tracker, name, infoHash, cached: !!cached };
}

export async function findAllTorrentFilesInDir(dir: string): Promise<string[]> {
	return (await readdir(dir))
		.filter((fn) => extname(fn) === ".torrent")
		.sort()
		.map((fn) => resolve(join(dir, fn)));
}

export function createEnsemblePieces(
	title: string,
	files: File[],
): { key: string; element: string | number; largestFile: File }[] | null {
	const episodeKeys = getEpisodeKeys(stripExtension(title));
	if (!episodeKeys) return null;
	const element = episodeKeys.episode;
	const largestFile = getLargestFile(files);
	return episodeKeys.keyTitles.map((keyTitle) => {
		const key = `${keyTitle}${episodeKeys.season ? `.${episodeKeys.season}` : ""}`;
		return { key, element, largestFile };
	});
}

export async function cacheEnsembleTorrentEntry(
	searchee: SearcheeWithInfoHash,
	torrentSavePaths?: Map<string, string>,
): Promise<EnsembleEntry[] | null> {
	const ensemblePieces = createEnsemblePieces(searchee.title, searchee.files);
	if (!ensemblePieces || !ensemblePieces.length) return [];

	let savePath: string | undefined;
	if (searchee.savePath) {
		savePath = searchee.savePath;
	} else if (torrentSavePaths) {
		savePath = torrentSavePaths.get(searchee.infoHash);
	} else {
		const downloadDirResult = await getClients()[0].getDownloadDir(
			searchee,
			{
				onlyCompleted: false,
			},
		);
		if (downloadDirResult.isErr()) {
			logger.error(
				`Failed to get download dir for ${getLogString(searchee)}: ${downloadDirResult.unwrapErr()}`,
			);
			return null;
		}
		savePath = downloadDirResult.unwrap();
	}
	if (!savePath) {
		logger.error(`Failed to get save path for ${getLogString(searchee)}`);
		return null;
	}

	return ensemblePieces.map((ensemblePiece) => ({
		client_host: searchee.clientHost ?? null,
		path: join(savePath, ensemblePiece.largestFile.path),
		info_hash: searchee.infoHash,
		ensemble: ensemblePiece.key,
		element: ensemblePiece.element,
	}));
}

async function indexTorrents(options: { startup: boolean }): Promise<void> {
	const { torrentDir, useClientTorrents } = getRuntimeConfig();
	if (torrentDir) {
		try {
			await refreshTorrentDirectory(torrentDir);
		} catch (error) {
			if (!isRecoverableTorrentDirError(error)) throw error;
			logRecoverableTorrentDirError(torrentDir, error);
		}
		return;
	}
	if (!useClientTorrents) return;
	for (const client of getClients()) {
		try {
			await client.getClientSearchees({
				newSearcheesOnly: !options.startup,
				includeFiles: true,
				includeTrackers: true,
			});
		} catch (error) {
			logger.warn({
				label: client.label,
				message: `Indexing client torrents failed; disabling client until next retry: ${errorMessage(error)}`,
			});
			logger.debug(error);
		}
	}
}

/** Own the namespace lease before enumeration, through publication and validated pruning. */
export async function refreshTorrentDirectory(dir: string): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const result = await refreshTorrentDirectoryOnce(dir);
		if (result !== "concurrent") return result;
	}
	throw new ClientCacheConcurrencyError();
}
async function refreshTorrentDirectoryOnce(
	dir: string,
): Promise<boolean | "concurrent"> {
	const namespaceId = await ensureSourceNamespace(
		db,
		"torrent-directory",
		dir,
	);
	const lease = beginClientCacheOperation(`filesystem:${namespaceId}`);
	try {
		const files = await findAllTorrentFilesInDir(dir);
		// Empty network directories and inaccessible catalogs are not removal authority.
		if (!files.length) return false;
		const searchees: SearcheeWithInfoHash[] = [];
		let validated = true;
		for (const filePath of files) {
			const origin = await findSourceOrigin(
				db,
				namespaceId,
				relative(dir, filePath),
			);
			const result = await createSearcheeFromTorrentFile(filePath, []);
			if (result.isErr()) {
				validated = false;
				continue;
			}
			searchees.push({
				...result.unwrap(),
				torrentFilePath: filePath,
				sourceOriginId: origin?.id,
				sourceRevision: origin?.revision ?? 0,
			});
		}
		const client = getClients()[0];
		const savePaths = client
			? await client.getAllDownloadDirs({
					metas: searchees,
					onlyCompleted: false,
					v1HashOnly: true,
				})
			: new Map<string, string>();
		const { seasonFromEpisodes } = getRuntimeConfig();
		const publication = await writeEnsembleTorrentEntries(
			searchees,
			(source) =>
				seasonFromEpisodes
					? cacheEnsembleTorrentEntry(source, savePaths)
					: Promise.resolve([]),
			lease,
		);
		// Compatibility file metadata commits through the same accepted publication.
		// A failed source prevents authoritative removal of any absent source.
		if (!validated || publication.unavailable) return false;
		if (!publication.complete) return "concurrent";
		const seen = new Set(files.map((path) => relative(dir, path)));
		return await completeClientCacheSnapshot(
			lease,
			async (trx, canRemove) => {
				const origins = await trx<SourceOrigin>("source_origin")
					.where({ namespace_id: namespaceId })
					.whereNot("state", "removed");
				const removed: string[] = [];
				for (const origin of origins)
					if (
						!seen.has(origin.source_key) &&
						canRemove(origin.source_key)
					) {
						if (
							await tombstoneSourceOrigin(
								trx,
								origin.id,
								origin.revision,
								origin.revision + 1,
							)
						) {
							await trx("torrent")
								.where({
									file_path: join(dir, origin.source_key),
								})
								.delete();
							removed.push(origin.source_key);
						}
					}
				return removed;
			},
		);
	} finally {
		releaseClientCacheOperation(lease);
	}
}

export async function reconcileSourceNamespaces(): Promise<void> {
	const { dataDirs, torrentDir, useClientTorrents } = getRuntimeConfig();
	const configured: Record<string, string[]> = {
		client: useClientTorrents
			? getClients().map((client) =>
					normalizeSourceLocator(
						"client",
						clientSourceLocator(client.clientHost),
					),
				)
			: [],
		"data-root": dataDirs,
		"torrent-directory": torrentDir ? [torrentDir] : [],
	};
	await db.transaction(async (trx) => {
		// Visibility policy does not turn unresolved history into owned sources.
		// Named historical clients must still be configured; unnamed history is
		// hidden when there is no configured source that can provide it.
		const hosts = useClientTorrents
			? getClients().map((client) => client.clientHost)
			: [];
		const viable =
			hosts.length > 0 || dataDirs.length > 0 || Boolean(torrentDir);
		await trx("source_origin")
			.where({ namespace_id: "legacy-unknown", state: "legacy-unknown" })
			.update({ visible: viable ? 1 : 0 });
		const named = () =>
			trx("source_origin")
				.where({
					namespace_id: "legacy-unknown",
					state: "legacy-unknown",
				})
				.whereRaw(
					"coalesce(json_extract(metadata,'$.clientHost'),'') <> ''",
				);
		await named().update({ visible: 0 });
		if (hosts.length)
			await named()
				.whereRaw(
					`json_extract(metadata,'$.clientHost') IN (${hosts.map(() => "?").join(",")})`,
					hosts,
				)
				.update({ visible: 1 });
		for (const [type, locators] of Object.entries(configured)) {
			await trx("source_namespace")
				.where({ type })
				.update({ enabled: 0 });
			if (locators.length)
				await trx("source_namespace")
					.where({ type })
					.whereIn("locator", locators)
					.update({ enabled: 1 });
		}
	});
	invalidateHealth();
}

export async function indexTorrentsAndDataDirs(
	options = { startup: false },
): Promise<void> {
	if (options.startup) await reconcileSourceNamespaces();
	return withMutex(
		Mutex.INDEX_TORRENTS_AND_DATA_DIRS,
		{ useQueue: false },
		async () => {
			const maxRetries = 3;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					await indexDataDirs(options); // Running together may increase failures
					await indexTorrents(options); // Run second so this data is more fresh
					break;
				} catch (e) {
					const log = {
						label: Label.INDEX,
						message: `Indexing failed (${maxRetries - attempt}): ${errorMessage(e)}`,
					};
					logger.debug(e);
					if (attempt < maxRetries) {
						logger.verbose(log);
					} else {
						logger.error(log);
						if (options.startup) throw e;
					}
				}
			}
		},
	);
}

function enabledClientEntriesQuery(): Knex.QueryBuilder<
	ClientSearcheeRow,
	ClientSearcheeRow[]
> {
	const clients = getClients();
	return db<ClientSearcheeRow>("client_searchee as cache")
		.select<ClientSearcheeRow[]>("cache.*")
		.where((builder) => {
			if (!clients.length) {
				builder.whereRaw("0");
				return;
			}
			for (const client of clients)
				builder.orWhere((owner) => {
					const locator = normalizeSourceLocator(
						"client",
						clientSourceLocator(client.clientHost),
					);
					owner
						.where("cache.client_host", client.clientHost)
						.andWhere((visible) => {
							visible.whereExists(
								db("source_alias as alias")
									.join(
										"source_origin as origin",
										"origin.id",
										"alias.origin_id",
									)
									.join(
										"source_namespace as namespace",
										"namespace.id",
										"origin.namespace_id",
									)
									.select(db.raw("1"))
									.where("namespace.type", "client")
									.where("namespace.locator", locator)
									.where("namespace.enabled", 1)
									.whereRaw(
										"namespace.id=cache.source_namespace_id",
									)
									.where("origin.state", "verified")
									.whereRaw("alias.alias=cache.info_hash"),
							);
							visible.orWhere((unresolved) => {
								unresolved.whereNull(
									"cache.source_namespace_id",
								);
								unresolved.whereNotExists(
									db("source_namespace as namespace")
										.select(db.raw("1"))
										.where("namespace.type", "client")
										.where("namespace.locator", locator),
								);
								// A known cache row from a previous endpoint is not
								// unresolved provenance for the newly bound endpoint.
								unresolved.whereNotExists(
									db("source_alias as alias")
										.join(
											"source_origin as origin",
											"origin.id",
											"alias.origin_id",
										)
										.join(
											"source_namespace as namespace",
											"namespace.id",
											"origin.namespace_id",
										)
										.select(db.raw("1"))
										.where("namespace.type", "client")
										.whereRaw("alias.alias=cache.info_hash")
										.whereRaw(
											"json_extract(origin.metadata,'$.clientHost')=cache.client_host",
										),
								);
							});
						});
				});
		});
}
function enabledTorrentEntriesQuery(): Knex.QueryBuilder<
	{ file_path: string; info_hash: string; name: string },
	{ file_path: string; info_hash: string; name: string }[]
> {
	const { torrentDir } = getRuntimeConfig();
	// Unary + removes outer TEXT affinity for indexed JSON string path comparisons.
	return db<{ file_path: string; info_hash: string; name: string }>(
		"torrent as cache",
	)
		.select<{ file_path: string; info_hash: string; name: string }[]>(
			"cache.*",
		)
		.where((builder) => {
			if (!torrentDir) {
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
					.where("namespace.type", "torrent-directory")
					.where("namespace.locator", torrentDir)
					.where("namespace.enabled", 1)
					.where("origin.state", "verified")
					.whereRaw(
						"json_extract(origin.metadata,'$.torrentFilePath')=+cache.file_path",
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
						.where("namespace.type", "torrent-directory")
						.whereRaw(
							"json_extract(origin.metadata,'$.torrentFilePath')=+cache.file_path",
						),
				);
				const root = torrentDir.replace(/\/+$/, "");
				unknown.whereRaw("substr(cache.file_path,1,?)=?", [
					root.length + 1,
					`${root}/`,
				]);
				unknown.whereNotExists(
					db("source_namespace as namespace")
						.select(db.raw("1"))
						.where("namespace.type", "torrent-directory")
						.where("namespace.locator", torrentDir)
						.where("namespace.enabled", 0),
				);
			});
		});
}

export async function getInfoHashesToExclude(): Promise<Set<string>> {
	if (getRuntimeConfig().useClientTorrents)
		return new Set(
			(await enabledClientEntriesQuery()).map((row) => row.info_hash),
		);
	return new Set(
		(await enabledTorrentEntriesQuery()).map((row) => row.info_hash),
	);
}

export async function loadTorrentDirLight(
	torrentDir: string,
): Promise<SearcheeWithInfoHash[]> {
	const namespaceId = await ensureSourceNamespace(
		db,
		"torrent-directory",
		torrentDir,
	);
	const torrentFilePaths = await findAllTorrentFilesInDir(torrentDir);

	const searchees: SearcheeWithInfoHash[] = [];
	const client = getClients()[0];
	const torrentInfos =
		client && client.clientType !== Label.QBITTORRENT
			? await client.getAllTorrents()
			: [];
	for (const torrentFilePath of torrentFilePaths) {
		const origin = await resolveSourceOrigin(
			db,
			namespaceId,
			relative(torrentDir, torrentFilePath),
		);
		const searcheeResult = await createSearcheeFromTorrentFile(
			torrentFilePath,
			torrentInfos,
		);
		if (searcheeResult.isOk()) {
			searchees.push({
				...searcheeResult.unwrap(),
				torrentFilePath,
				sourceRevision: origin?.revision ?? 0,
				sourceOriginId: origin?.id,
			});
		}
	}
	return searchees;
}

function getKeysFromName(stem: string): {
	keyTitles: string[];
	element?: string | number;
	useFallback: boolean;
} {
	const episodeKeys = getEpisodeKeys(stem);
	if (episodeKeys) {
		const keyTitles = episodeKeys.keyTitles;
		const element = `${episodeKeys.season ? `${episodeKeys.season}.` : ""}${episodeKeys.episode}`;
		return { keyTitles, element, useFallback: false };
	}
	const seasonKeys = getSeasonKeys(stem);
	if (seasonKeys) {
		const keyTitles = seasonKeys.keyTitles;
		const element = seasonKeys.season;
		return { keyTitles, element, useFallback: false };
	}
	const movieKeys = getMovieKeys(stem);
	if (movieKeys) {
		const keyTitles = movieKeys.keyTitles;
		return { keyTitles, useFallback: false };
	}
	const animeKeys = getAnimeKeys(stem);
	if (animeKeys) {
		const keyTitles = animeKeys.keyTitles;
		const element = animeKeys.release;
		return { keyTitles, element, useFallback: false };
	}
	return { keyTitles: [], useFallback: true };
}

export async function getSimilarByName(name: string): Promise<{
	keys: string[];
	clientSearchees: SearcheeWithInfoHash[];
	dataSearchees: SearcheeWithoutInfoHash[];
}> {
	const { torrentDir, useClientTorrents } = getRuntimeConfig();
	const stem = stripExtension(name);
	const { keyTitles, element, useFallback } = getKeysFromName(stem);
	const clientSearchees = useFallback
		? await getTorrentByFuzzyName(stem)
		: [];
	const dataSearchees = useFallback ? await getDataByFuzzyName(stem) : [];
	if (!keyTitles.length) {
		const noParentheses = stem
			.replace(ALL_SQUARE_BRACKETS_REGEX, "")
			.replace(ALL_PARENTHESES_REGEX, "")
			.replace(ALL_SPACES_REGEX, " ")
			.trim(); // Anime that fails MediaType.ANIME often has `[group] Title (Extra Info)`
		if (
			noParentheses.length >= MIN_VIDEO_QUERY_LENGTH &&
			noParentheses !== stem
		) {
			clientSearchees.push(
				...(await getTorrentByFuzzyName(noParentheses)),
			);
			dataSearchees.push(...(await getDataByFuzzyName(noParentheses)));
		}
		return { keys: [], clientSearchees, dataSearchees };
	}
	const candidateMaxDistance = Math.floor(
		Math.min(...keyTitles.map((t) => t.length)) / LEVENSHTEIN_DIVISOR,
	);

	const filterEntries = async (dbEntries: TorrentEntry[]) => {
		return filterAsyncYield(dbEntries, (dbEntry) => {
			const entry = getKeysFromName(dbEntry.title ?? dbEntry.name!);
			if (entry.element !== element) return Promise.resolve(false);
			if (!entry.keyTitles.length) return Promise.resolve(false);
			const maxDistance = Math.min(
				candidateMaxDistance,
				Math.floor(
					Math.min(...entry.keyTitles.map((t) => t.length)) /
						LEVENSHTEIN_DIVISOR,
				),
			);
			return Promise.resolve(
				entry.keyTitles.some((dbKeyTitle) => {
					return keyTitles.some(
						(keyTitle) =>
							distance(keyTitle, dbKeyTitle) <= maxDistance,
					);
				}),
			);
		});
	};

	if (useClientTorrents) {
		clientSearchees.push(
			...(await filterEntries(await enabledClientEntriesQuery())).map(
				createSearcheeFromDB,
			),
		);
	} else if (torrentDir) {
		const filteredTorrentEntries = (await filterEntries(
			await enabledTorrentEntriesQuery(),
		)) as { name: string; file_path: string }[];
		if (filteredTorrentEntries.length) {
			const client = getClients()[0];
			const torrentInfos =
				client && client.clientType !== Label.QBITTORRENT
					? await client.getAllTorrents()
					: [];
			clientSearchees.push(
				...(
					await mapAsync(filteredTorrentEntries, (dbTorrent) =>
						createSearcheeFromTorrentFile(
							dbTorrent.file_path,
							torrentInfos,
						),
					)
				)
					.filter(isOk)
					.map((r) => r.unwrap()),
			);
		}
	}

	const entriesToDelete: string[] = [];
	const filteredDataEntries = await filterAsync(
		(await filterEntries(await enabledDataEntriesQuery())) as {
			title: string;
			path: string;
		}[],
		async ({ path }) => {
			if (
				(await notExists(path)) ||
				shouldIgnorePathHeuristically(
					path,
					(await stat(path)).isDirectory(),
				)
			) {
				entriesToDelete.push(path);
				return false;
			}
			return true;
		},
	);
	void entriesToDelete;
	if (filteredDataEntries.length) {
		dataSearchees.push(
			...(
				await mapAsync(filteredDataEntries, (dbData) =>
					createSearcheeFromPath(dbData.path),
				)
			)
				.filter(isOk)
				.map((r) => r.unwrap()),
		);
	}
	const keys = element
		? keyTitles.map((keyTitle) => `${keyTitle}.${element}`)
		: keyTitles;
	return { keys, clientSearchees, dataSearchees };
}

async function getTorrentByFuzzyName(
	stem: string,
): Promise<SearcheeWithInfoHash[]> {
	const { useClientTorrents } = getRuntimeConfig();

	const database: TorrentEntry[] = useClientTorrents
		? await enabledClientEntriesQuery()
		: await enabledTorrentEntriesQuery();
	const fullMatch = createKeyTitle(stem);

	// Attempt to filter torrents in DB to match incoming data before fuzzy check
	let filteredNames: TorrentEntry[] = [];
	if (fullMatch) {
		filteredNames = await filterAsyncYield(database, (dbEntry) => {
			const dbMatch = createKeyTitle(
				stripExtension(dbEntry.title ?? dbEntry.name!),
			);
			return Promise.resolve(fullMatch === dbMatch);
		});
	}

	// If none match, proceed with fuzzy name check on all names.
	filteredNames = filteredNames.length > 0 ? filteredNames : database;

	const candidateMaxDistance = Math.floor(stem.length / LEVENSHTEIN_DIVISOR);
	const potentialMatches = await filterAsyncYield(
		filteredNames,
		(dbEntry) => {
			const dbTitle = stripExtension(dbEntry.title ?? dbEntry.name!);
			const maxDistance = Math.min(
				candidateMaxDistance,
				Math.floor(dbTitle.length / LEVENSHTEIN_DIVISOR),
			);
			return Promise.resolve(distance(stem, dbTitle) <= maxDistance);
		},
	);

	if (useClientTorrents) return potentialMatches.map(createSearcheeFromDB);
	const client = getClients()[0];
	const torrentInfos =
		client && client.clientType !== Label.QBITTORRENT
			? await client.getAllTorrents()
			: [];
	return (
		await mapAsync(potentialMatches, (dbTorrent) =>
			createSearcheeFromTorrentFile(dbTorrent.file_path!, torrentInfos),
		)
	)
		.filter(isOk)
		.map((r) => r.unwrap());
}

export async function getTorrentByCriteria(
	criteria: TorrentLocator,
): Promise<SearcheeWithInfoHash[]> {
	const { useClientTorrents } = getRuntimeConfig();
	const database = useClientTorrents
		? enabledClientEntriesQuery()
		: enabledTorrentEntriesQuery();
	const dbTorrents = await database.where((b) =>
		b.where({ info_hash: criteria.infoHash }),
	);
	if (!dbTorrents.length) {
		const message = `Torrent client does not have any torrent with criteria ${inspect(
			criteria,
		)}`;
		throw new Error(message);
	}
	if (useClientTorrents)
		return (dbTorrents as ClientSearcheeRow[]).map(createSearcheeFromDB);

	const client = getClients()[0];
	const torrentInfos =
		client && client.clientType !== Label.QBITTORRENT
			? await client.getAllTorrents()
			: [];
	const torrentRow = dbTorrents[0] as { file_path: string };
	return [
		(
			await createSearcheeFromTorrentFile(
				torrentRow.file_path,
				torrentInfos,
			)
		).unwrapOrThrow(
			new Error(`Failed to create searchee from ${torrentRow.file_path}`),
		),
	];
}
