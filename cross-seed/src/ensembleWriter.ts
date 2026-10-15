import { setImmediate } from "node:timers/promises";
import { relative } from "node:path";
import { db } from "./db.js";
import type { EnsembleEntry } from "./torrent.js";
import type { SearcheeWithInfoHash } from "./searchee.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import {
	clientSourceLocator,
	findSourceOrigin,
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

/** Generate outside SQLite; namespace leases order scans and origin CAS guards publication. */
export async function writeEnsembleTorrentEntries(
	sources: readonly SearcheeWithInfoHash[],
	createEntries: (
		source: SearcheeWithInfoHash,
	) => Promise<EnsembleEntry[] | null>,
	operation?: ClientCacheLease,
): Promise<{ complete: boolean; unavailable: boolean }> {
	const owned = new Map<string, ClientCacheLease>();
	let complete = true;
	let unavailable = false;
	try {
		for (let offset = 0; offset < sources.length; offset += 64) {
			const prepared: Array<{
				source: SearcheeWithInfoHash;
				origin: SourceOrigin | undefined;
				key: string;
				namespace: string;
				lease: ClientCacheLease;
			}> = [];
			for (const source of sources.slice(offset, offset + 64)) {
				const torrentDir = getRuntimeConfig().torrentDir;
				const ns = await ensureSourceNamespace(
					db,
					source.clientHost ? "client" : "torrent-directory",
					source.clientHost
						? clientSourceLocator(source.clientHost)
						: (torrentDir ?? "unconfigured-torrent-directory"),
				);
				const key = source.clientHost
					? source.infoHash
					: source.torrentFilePath && torrentDir
						? relative(torrentDir, source.torrentFilePath)
						: (source.torrentFilePath ?? source.infoHash);
				const owner = source.clientHost ?? `filesystem:${ns}`;
				let lease = operation ?? owned.get(owner);
				if (!lease) {
					lease = beginClientCacheOperation(owner);
					owned.set(owner, lease);
				}
				const current = await findSourceOrigin(db, ns, key);
				const origin =
					current &&
					source.sourceOriginId === current.id &&
					source.sourceRevision !== undefined
						? { ...current, revision: source.sourceRevision }
						: current;
				if (source.clientHost && current?.state === "verified")
					continue;
				prepared.push({ source, origin, key, lease, namespace: ns });
			}
			const generated = await Promise.allSettled(
				prepared.map(({ source }) => createEntries(source)),
			);
			for (let i = 0; i < generated.length; i++) {
				const result = generated[i];
				if (result.status !== "fulfilled") continue;
				if (result.value === null) {
					complete = false;
					unavailable = true;
					continue;
				}
				const { source, origin, key, lease, namespace } = prepared[i];
				const memberships = result.value.map((m) => ({
					path: m.path,
					ensemble: m.ensemble,
					element: normalizeSourceElement(m.element),
				}));
				try {
					complete =
						(await publishClientCacheBatch(
							lease,
							[key],
							async (trx) => {
								const acceptedOrigin =
									origin ??
									(await resolveSourceOrigin(
										trx,
										namespace,
										key,
									));
								if (
									!(await replaceSourcePublication(trx, {
										originId: acceptedOrigin.id,
										expectedRevision:
											acceptedOrigin.revision,
										revision: acceptedOrigin.revision + 1,
										metadata: source,
										memberships,
										status: "verified",
									}))
								)
									throw new ClientCacheConcurrencyError();
								if (source.torrentFilePath)
									await trx("torrent")
										.insert({
											file_path: source.torrentFilePath,
											info_hash: source.infoHash,
											name: source.name,
										})
										.onConflict("file_path")
										.merge();
							},
						)) && complete;
				} catch (error) {
					if (!(error instanceof ClientCacheConcurrencyError))
						throw error;
					complete = false;
				}
			}
			const failed = generated.find((r) => r.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
			await setImmediate();
		}
		return { complete, unavailable };
	} finally {
		for (const lease of owned.values()) releaseClientCacheOperation(lease);
	}
}
