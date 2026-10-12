import { db } from "../db.js";
import { ClientSearcheeRow } from "../searchee.js";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export type ClientSearcheeChangeRow = Pick<
	ClientSearcheeRow,
	"info_hash" | "name" | "save_path" | "category" | "tags"
>;

const CACHE_READ_BATCH_SIZE = 500;
const CACHE_HYDRATION_BYTES = 1024 * 1024;
type SizedChangeRow = ClientSearcheeChangeRow & { files_bytes?: number | null };
type SizeRow = { info_hash: string; files_bytes: number | null };

/** Read change fields first; transfer serialized files only for cached output. */
export async function* cachedClientTorrents<T>(
	torrents: T[],
	clientHost: string,
	infoHashOf: (torrent: T) => string,
	useCache: (
		torrent: T,
		row: ClientSearcheeChangeRow | undefined,
		infoHash: string,
		index: number,
	) => boolean,
	includeCached: boolean,
) {
	for (
		let offset = 0;
		offset < torrents.length;
		offset += CACHE_READ_BATCH_SIZE
	) {
		const batch = torrents.slice(offset, offset + CACHE_READ_BATCH_SIZE);
		const hashes = batch.map(infoHashOf);
		const rows = await db<SizedChangeRow>("client_searchee")
			.where("client_host", clientHost)
			.whereIn("info_hash", hashes)
			.select<SizedChangeRow[]>(
				"info_hash",
				"name",
				"save_path",
				"category",
				"tags",
				...(includeCached
					? [db.raw("length(cast(files as blob)) as files_bytes")]
					: []),
			);
		const changes = new Map(rows.map((row) => [row.info_hash, row]));
		const entries = batch.map((torrent, index) => ({
			torrent,
			index: offset + index,
			infoHash: hashes[index],
			useCache: useCache(
				torrent,
				changes.get(hashes[index]),
				hashes[index],
				offset + index,
			),
		}));
		// Keep file JSON buffers bounded too, rather than holding 500 huge rows.
		// An individual torrent larger than the budget is read on its own.
		let cursor = 0;
		while (cursor < entries.length) {
			const first = cursor;
			let bytes = 0;
			while (cursor < entries.length) {
				const entry = entries[cursor];
				const size =
					includeCached && entry.useCache
						? (changes.get(entry.infoHash)?.files_bytes ?? 0)
						: 0;
				if (cursor > first && bytes + size > CACHE_HYDRATION_BYTES)
					break;
				bytes += size;
				cursor++;
			}
			const group = entries.slice(first, cursor);
			const cachedHashes = includeCached
				? group
						.filter((entry) => entry.useCache)
						.map((entry) => entry.infoHash)
				: [];
			let cachedRows: ClientSearcheeRow[] = [];
			if (cachedHashes.length === 1) {
				// A single row cannot combine oversized file JSON buffers.
				cachedRows = await db<ClientSearcheeRow>("client_searchee")
					.where("client_host", clientHost)
					.whereIn("info_hash", cachedHashes)
					.select("*");
			} else if (cachedHashes.length > 1) {
				const plannedEnd = cursor;
				const hydrated = await db.transaction(async (trx) => {
					// Recheck sizes in the same SQLite read snapshot as hydration:
					// another refresh may have grown files since the light read.
					const sizes = await trx<SizeRow>("client_searchee")
						.where("client_host", clientHost)
						.whereIn("info_hash", cachedHashes)
						.select<
							SizeRow[]
						>("info_hash", trx.raw("length(cast(files as blob)) as files_bytes"));
					const currentSizes = new Map(
						sizes.map((row) => [row.info_hash, row.files_bytes]),
					);
					for (const row of sizes) {
						const checked = changes.get(row.info_hash);
						if (checked) checked.files_bytes = row.files_bytes;
					}
					let end = first,
						bytes = 0;
					while (end < plannedEnd) {
						const entry = entries[end];
						const size = entry.useCache
							? (currentSizes.get(entry.infoHash) ?? 0)
							: 0;
						if (end > first && bytes + size > CACHE_HYDRATION_BYTES)
							break;
						bytes += size;
						end++;
					}
					const selectedHashes = entries
						.slice(first, end)
						.filter((entry) => entry.useCache)
						.map((entry) => entry.infoHash);
					const rows = selectedHashes.length
						? await trx<ClientSearcheeRow>("client_searchee")
								.where("client_host", clientHost)
								.whereIn("info_hash", selectedHashes)
								.select("*")
						: [];
					return { end, rows };
				});
				cursor = hydrated.end;
				cachedRows = hydrated.rows;
			}

			const details = new Map(
				cachedRows.map((row) => [row.info_hash, row]),
			);
			for (const entry of entries.slice(first, cursor)) {
				const row = details.get(entry.infoHash);
				const checked = changes.get(entry.infoHash);
				let cached = entry.useCache;
				if (cached && includeCached) {
					if (!row) cached = false;
					else if (
						row.name !== checked?.name ||
						row.save_path !== checked?.save_path ||
						row.category !== checked?.category ||
						row.tags !== checked?.tags
					) {
						cached = useCache(
							entry.torrent,
							row,
							entry.infoHash,
							entry.index,
						);
					}
				}
				yield { ...entry, useCache: cached, dbTorrent: row };
			}

			if (cursor < entries.length) await yieldToEventLoop();
		}
		if (offset + CACHE_READ_BATCH_SIZE < torrents.length) {
			await yieldToEventLoop();
		}
	}
}
