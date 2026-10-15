import { createHash } from "node:crypto";
import type { Knex } from "knex";
import {
	normalizeSourceElement,
	type SourcePublication,
	type SourceOrigin,
} from "./sourceStore.js";

/** Existing equivalences and isolated new keys qualify; ambiguous aliases use the strict resolver. */
export async function resolveExistingSourceOrigins(
	trx: Knex.Transaction,
	namespace: string,
	sources: readonly { key: string; aliases: readonly string[] }[],
): Promise<Map<string, SourceOrigin>> {
	const keys = [
		...new Set(
			sources.flatMap((source) => [source.key, ...source.aliases]),
		),
	];
	if (!keys.length) return new Map();
	const rows = await trx("source_alias as alias")
		.join("source_origin as origin", "alias.origin_id", "origin.id")
		.where("alias.namespace_id", namespace)
		.whereIn("alias.alias", keys)
		.whereNot("origin.state", "superseded")
		.select<
			(SourceOrigin & { alias: string })[]
		>("origin.*", "alias.alias");
	const byAlias = new Map(rows.map((row) => [row.alias, row]));
	const direct = await trx<SourceOrigin>("source_origin")
		.where("namespace_id", namespace)
		.whereIn("source_key", keys);
	const directKeys = new Set(direct.map((origin) => origin.source_key));
	const uses = new Map<string, number>();
	for (const source of sources)
		for (const key of new Set([source.key, ...source.aliases]))
			uses.set(key, (uses.get(key) ?? 0) + 1);
	const isolated = sources.filter(
		(source) =>
			source.key &&
			source.aliases.every(Boolean) &&
			[...new Set([source.key, ...source.aliases])].every(
				(key) =>
					uses.get(key) === 1 &&
					!byAlias.has(key) &&
					!directKeys.has(key),
			),
	);
	if (isolated.length) {
		const created: SourceOrigin[] = isolated.map((source) => ({
			id: createHash("sha256")
				.update(JSON.stringify([namespace, source.key]))
				.digest("hex"),
			namespace_id: namespace,
			source_key: source.key,
			revision: 0,
			state: "unavailable",
			metadata: "{}",
		}));
		for (let offset = 0; offset < created.length; offset += 100)
			await trx("source_origin").insert(
				created.slice(offset, offset + 100),
			);
		const aliasRows = created.flatMap((origin, index) =>
			[...new Set([isolated[index].key, ...isolated[index].aliases])].map(
				(alias) => ({
					namespace_id: namespace,
					alias,
					origin_id: origin.id,
				}),
			),
		);
		for (let offset = 0; offset < aliasRows.length; offset += 300)
			await trx("source_alias").insert(
				aliasRows.slice(offset, offset + 300),
			);
		for (let index = 0; index < created.length; index++)
			for (const key of new Set([
				isolated[index].key,
				...isolated[index].aliases,
			]))
				byAlias.set(key, { ...created[index], alias: key });
	}

	const result = new Map<string, SourceOrigin>();
	const counts = new Map<string, number>();
	const blocked = new Set<string>();
	for (const source of sources) {
		const origin = byAlias.get(source.key);
		if (
			!origin ||
			source.aliases.some((alias) => byAlias.get(alias)?.id !== origin.id)
		) {
			for (const key of [source.key, ...source.aliases]) {
				const bound =
					byAlias.get(key) ??
					direct.find(
						(candidate) =>
							candidate.source_key === key &&
							candidate.state !== "superseded",
					);
				if (bound) blocked.add(bound.id);
			}
			continue;
		}
		result.set(source.key, origin);
		counts.set(origin.id, (counts.get(origin.id) ?? 0) + 1);
	}
	// Preserve sequential semantics when a batch publishes the same origin twice.
	for (const [key, origin] of result)
		if (counts.get(origin.id)! > 1 || blocked.has(origin.id))
			result.delete(key);
	return result;
}

/** Caller owns the transaction; any failed CAS throws so every metadata/member write rolls back. */
export async function replaceSourcePublicationBatch(
	trx: Knex.Transaction,
	publications: readonly SourcePublication[],
): Promise<void> {
	if (!publications.length) return;
	if (
		new Set(publications.map((p) => p.originId)).size !==
			publications.length ||
		publications.some(
			(p) =>
				p.status !== "verified" ||
				!Number.isSafeInteger(p.expectedRevision) ||
				p.expectedRevision < 0 ||
				!Number.isSafeInteger(p.revision) ||
				p.revision <= p.expectedRevision,
		)
	)
		throw new Error("Client source publication revision conflict");
	const ids = publications.map((p) => p.originId);

	const changed = await trx.raw<{ id: string }[]>(
		`WITH updates(id,expected_revision,next_revision,next_metadata) AS (VALUES ${publications.map(() => "(?,?,?,?)").join(",")})
   UPDATE source_origin SET revision=updates.next_revision,metadata=updates.next_metadata,state='verified'
   FROM updates WHERE source_origin.id=updates.id AND source_origin.revision=updates.expected_revision RETURNING source_origin.id`,
		publications.flatMap((p) => [
			p.originId,
			p.expectedRevision,
			p.revision,
			JSON.stringify(p.metadata),
		]),
	);
	if (changed.length !== publications.length)
		throw new Error("Client source publication revision conflict");

	const old = await trx("ensemble_membership as member")
		.join("physical_path as path", "member.path_id", "path.id")
		.whereIn("member.origin_id", ids)
		.select<
			{
				origin_id: string;
				path: string;
				ensemble: string;
				element: string;
				selection_order: number;
			}[]
		>("member.origin_id", "path.path", "member.ensemble", "member.element", "member.selection_order");
	const orders = new Map(
		old.map((row) => [
			JSON.stringify([
				row.origin_id,
				row.path,
				row.ensemble,
				row.element,
			]),
			row.selection_order,
		]),
	);

	const nextTuples = new Set(
		publications.flatMap((p) =>
			p.memberships.map((member) =>
				JSON.stringify([
					p.originId,
					member.path,
					member.ensemble,
					normalizeSourceElement(member.element),
				]),
			),
		),
	);
	const unchanged =
		nextTuples.size === old.length &&
		[...nextTuples].every((key) => orders.has(key));
	if (!unchanged) {
		const maximum = await trx("ensemble_membership")
			.max<{ n: number | null }>({ n: "selection_order" })
			.first();
		let nextOrder = (maximum?.n ?? 0) + 1;
		await trx("ensemble_membership").whereIn("origin_id", ids).delete();
		const paths = [
			...new Set(
				publications.flatMap((p) => p.memberships.map((m) => m.path)),
			),
		];
		for (let offset = 0; offset < paths.length; offset += 200)
			await trx("physical_path")
				.insert(
					paths.slice(offset, offset + 200).map((path) => ({ path })),
				)
				.onConflict("path")
				.ignore();
		const pathIds = new Map<string, number>();
		for (let offset = 0; offset < paths.length; offset += 400) {
			const found = await trx<{ id: number; path: string }>(
				"physical_path",
			)
				.whereIn("path", paths.slice(offset, offset + 400))
				.select("id", "path");
			for (const row of found) pathIds.set(row.path, row.id);
		}
		const members = publications.flatMap((p) =>
			p.memberships.map((member) => {
				const element = normalizeSourceElement(member.element);
				return {
					origin_id: p.originId,
					path_id: pathIds.get(member.path)!,
					ensemble: member.ensemble,
					element,
					selection_order:
						orders.get(
							JSON.stringify([
								p.originId,
								member.path,
								member.ensemble,
								element,
							]),
						) ??
						member.selectionOrder ??
						nextOrder++,
				};
			}),
		);
		for (let offset = 0; offset < members.length; offset += 150)
			await trx("ensemble_membership")
				.insert(members.slice(offset, offset + 150))
				.onConflict(["origin_id", "path_id", "ensemble", "element"])
				.ignore();
	}
	const clients = publications
		.map(
			(p) =>
				p.metadata as {
					clientHost?: unknown;
					infoHash?: unknown;
				} | null,
		)
		.filter(
			(p): p is { clientHost: string; infoHash: string } =>
				typeof p?.clientHost === "string" &&
				typeof p.infoHash === "string",
		);
	if (clients.length) {
		const identities = [
			...new Map(
				clients.map((client) => [
					JSON.stringify([client.clientHost, client.infoHash]),
					client,
				]),
			).values(),
		];
		// Keep incoming identities outside the origin scan so SQLite seeks all
		// four index keys, including the two JSON expressions. An OR list here
		// otherwise scans every retained legacy data origin for each batch.
		const legacy = await trx.raw<{ id: string }[]>(
			`WITH clients(host,hash) AS (VALUES ${identities.map(() => "(?,?)").join(",")})
SELECT origin.id FROM clients CROSS JOIN source_origin AS origin
WHERE origin.namespace_id='legacy-unknown' AND origin.state='legacy-unknown'
AND json_extract(origin.metadata,'$.clientHost')=clients.host
AND json_extract(origin.metadata,'$.infoHash')=clients.hash`,
			identities.flatMap((client) => [
				client.clientHost,
				client.infoHash,
			]),
		);
		if (legacy.length) {
			const legacyIds = legacy.map((row) => row.id);
			for (let offset = 0; offset < legacyIds.length; offset += 400) {
				const batch = legacyIds.slice(offset, offset + 400);
				await trx("ensemble_membership")
					.whereIn("origin_id", batch)
					.delete();
				await trx("source_origin")
					.whereIn("id", batch)
					.update({
						state: "superseded",
						revision: trx.raw("revision+1"),
					});
			}
		}
	}
}
