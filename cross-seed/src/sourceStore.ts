import { createHash } from "node:crypto";
import type { Knex } from "knex";

export type SourceNamespaceType =
	| "client"
	| "data-root"
	| "torrent-directory"
	| "legacy-unknown";
export interface SourceOrigin {
	id: string;
	namespace_id: string;
	source_key: string;
	revision: number;
	state: string;
	metadata: string;
}
export interface SourceMembership {
	path: string;
	ensemble: string;
	element: string | number;
	selectionOrder?: number;
}

/** Match legacy SQLite TEXT affinity for numeric episode bindings; retain literal strings. */
export function normalizeSourceElement(element: string | number): string {
	return typeof element === "number" && Number.isInteger(element)
		? `${element}.0`
		: String(element);
}
export interface SourcePublication {
	originId: string;
	expectedRevision: number;
	revision: number;
	metadata: unknown;
	memberships: SourceMembership[];
	status: "verified" | "unavailable";
}
const identity = (...parts: string[]) =>
	createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export function normalizeSourceLocator(
	type: SourceNamespaceType,
	locator: string,
): string {
	if (type !== "client") return locator;
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(locator);
	const url = new URL(hasScheme ? locator : `http://${locator}`);
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	url.pathname = url.pathname.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
	const result = url.toString().replace(/\/$/, "");
	return hasScheme ? result : result.replace(/^http:\/\//, "");
}
export async function ensureSourceNamespace(
	db: Knex,
	type: SourceNamespaceType,
	locator: string,
): Promise<string> {
	const normalized = normalizeSourceLocator(type, locator);
	const id = identity(type, normalized);
	await db("source_namespace")
		.insert({ id, type, locator: normalized })
		.onConflict(["type", "locator"])
		.ignore();
	const row = await db<{ id: string; type: string; locator: string }>(
		"source_namespace",
	)
		.where({ type, locator: normalized })
		.first();
	return row!.id;
}
// Aliases are authoritative equivalences supplied by the caller, never inferred
// from shared paths or matched across namespace boundaries.
export async function resolveSourceOrigin(
	db: Knex,
	namespaceId: string,
	sourceKey: string,
	aliases: string[] = [],
	options: { authoritativeAliases?: boolean } = {},
): Promise<SourceOrigin> {
	if (!sourceKey || aliases.some((alias) => !alias))
		throw new Error("Source keys and aliases must be nonempty");
	return db.transaction(async (trx) => {
		const keys = [...new Set([sourceKey, ...aliases])];
		const mapped = await trx<{
			origin_id: string;
			namespace_id: string;
			alias: string;
		}>("source_alias")
			.where({ namespace_id: namespaceId })
			.whereIn("alias", keys);
		const direct = await trx<SourceOrigin>("source_origin")
			.where({ namespace_id: namespaceId })
			.whereNot("state", "superseded")
			.whereIn("source_key", keys);
		const ids = new Set([
			...mapped.map((r) => r.origin_id),
			...direct.map((r) => r.id),
		]);
		if (ids.size > 1 && !options.authoritativeAliases)
			throw new Error(
				"Conflicting source aliases require an explicit authoritative rebind",
			);
		const id =
			direct.find((origin) => origin.source_key === sourceKey)?.id ??
			[...ids].sort()[0] ??
			identity(namespaceId, sourceKey);
		if (ids.size > 1) {
			// The caller proved alias equivalence using authoritative metadata.
			// Canonical identity follows the requested key when already known;
			// preserve the newest accepted metadata and all ownership until the
			// caller atomically replaces this merged publication.
			const origins = await trx<SourceOrigin>("source_origin")
				.where({ namespace_id: namespaceId })
				.whereIn("id", [...ids]);
			const latest = [...origins].sort(
				(a, b) => b.revision - a.revision || a.id.localeCompare(b.id),
			)[0];
			await trx("source_origin").where({ id }).update({
				revision: latest.revision,
				state: latest.state,
				metadata: latest.metadata,
			});
			for (const losing of origins.filter((origin) => origin.id !== id)) {
				await trx.raw(
					`INSERT INTO ensemble_membership(origin_id,path_id,ensemble,element,selection_order)
                  SELECT ?,path_id,ensemble,element,selection_order FROM ensemble_membership WHERE origin_id=?
                  ON CONFLICT(origin_id,path_id,ensemble,element) DO UPDATE SET selection_order=MIN(selection_order,excluded.selection_order)`,
					[id, losing.id],
				);
				await trx("ensemble_membership")
					.where({ origin_id: losing.id })
					.delete();
				await trx("source_alias")
					.where({ namespace_id: namespaceId, origin_id: losing.id })
					.update({ origin_id: id });
				await trx("source_origin")
					.where({ id: losing.id })
					.update({
						state: "superseded",
						revision: trx.raw("revision+1"),
					});
			}
		}
		if (!ids.size)
			await trx("source_origin").insert({
				id,
				namespace_id: namespaceId,
				source_key: sourceKey,
				revision: 0,
				state: "unavailable",
				metadata: "{}",
			});
		for (const alias of keys)
			await trx("source_alias")
				.insert({ namespace_id: namespaceId, alias, origin_id: id })
				.onConflict(["namespace_id", "alias"])
				.ignore();
		return (await trx<SourceOrigin>("source_origin")
			.where({ id })
			.first())!;
	});
}

export async function replaceSourcePublication(
	db: Knex,
	publication: SourcePublication,
): Promise<boolean> {
	if (publication.status === "unavailable") return false;
	if (
		!Number.isSafeInteger(publication.revision) ||
		!Number.isSafeInteger(publication.expectedRevision) ||
		publication.expectedRevision < 0 ||
		publication.revision <= publication.expectedRevision
	)
		return false;
	return db.transaction(async (trx) => {
		const changed = await trx("source_origin")
			.where({
				id: publication.originId,
				revision: publication.expectedRevision,
			})
			.update({
				revision: publication.revision,
				state: "verified",
				metadata: JSON.stringify(publication.metadata),
			});
		if (!changed) return false;
		// Retain the selection order of tuples that survive the replacement.
		const old = await trx<{
			origin_id: string;
			path: string;
			ensemble: string;
			element: string;
			selection_order: number;
		}>("ensemble_membership")
			.join("physical_path", "path_id", "physical_path.id")
			.where({ origin_id: publication.originId })
			.select("path", "ensemble", "element", "selection_order");
		const orders = new Map(
			(
				old as Array<{
					path: string;
					ensemble: string;
					element: string;
					selection_order: number;
				}>
			).map((r) => [
				JSON.stringify([r.path, r.ensemble, r.element]),
				r.selection_order,
			]),
		);
		const maximum = (await trx("ensemble_membership")
			.max({ n: "selection_order" })
			.first()) as { n: number | null };
		let nextOrder = (maximum.n ?? 0) + 1;
		await trx("ensemble_membership")
			.where({ origin_id: publication.originId })
			.delete();
		const uniquePaths = [
			...new Set(publication.memberships.map((m) => m.path)),
		];
		for (let offset = 0; offset < uniquePaths.length; offset += 200) {
			await trx("physical_path")
				.insert(
					uniquePaths
						.slice(offset, offset + 200)
						.map((path) => ({ path })),
				)
				.onConflict("path")
				.ignore();
		}
		const pathIds = new Map<string, number>();
		for (let offset = 0; offset < uniquePaths.length; offset += 400) {
			const paths = await trx<{ id: number; path: string }>(
				"physical_path",
			)
				.whereIn("path", uniquePaths.slice(offset, offset + 400))
				.select("id", "path");
			for (const path of paths) pathIds.set(path.path, path.id);
		}
		const members = publication.memberships.map((member) => {
			const element = normalizeSourceElement(member.element);
			return {
				origin_id: publication.originId,
				path_id: pathIds.get(member.path)!,
				ensemble: member.ensemble,
				element,
				selection_order:
					orders.get(
						JSON.stringify([member.path, member.ensemble, element]),
					) ??
					member.selectionOrder ??
					nextOrder++,
			};
		});
		for (let offset = 0; offset < members.length; offset += 150) {
			await trx("ensemble_membership")
				.insert(members.slice(offset, offset + 150))
				.onConflict(["origin_id", "path_id", "ensemble", "element"])
				.ignore();
		}
		const metadata = publication.metadata as {
			clientHost?: unknown;
			infoHash?: unknown;
		} | null;
		if (
			typeof metadata?.clientHost === "string" &&
			typeof metadata.infoHash === "string"
		) {
			// Exact named client + hash proves this historical owner. NULL-host
			// rows and lost alternate hashes retain their unresolved provenance.
			const legacy = await trx<SourceOrigin>("source_origin")
				.where({
					namespace_id: "legacy-unknown",
					state: "legacy-unknown",
				})
				.whereRaw(
					"json_extract(metadata, '$.clientHost') = ? AND json_extract(metadata, '$.infoHash') = ?",
					[metadata.clientHost, metadata.infoHash],
				)
				.select("id");
			for (const origin of legacy) {
				await trx("ensemble_membership")
					.where({ origin_id: origin.id })
					.delete();
				await trx("source_origin")
					.where({ id: origin.id })
					.update({
						state: "superseded",
						revision: trx.raw("revision+1"),
					});
			}
		}
		return true;
	});
}

export async function tombstoneSourceOrigin(
	db: Knex,
	originId: string,
	expectedRevision: number,
	revision: number,
): Promise<boolean> {
	if (
		!Number.isSafeInteger(revision) ||
		!Number.isSafeInteger(expectedRevision) ||
		expectedRevision < 0 ||
		revision <= expectedRevision
	)
		return false;
	return db.transaction(async (trx) => {
		const changed = await trx("source_origin")
			.where({ id: originId, revision: expectedRevision })
			.update({ revision, state: "removed" });
		if (!changed) return false;
		await trx("ensemble_membership")
			.where({ origin_id: originId })
			.delete();
		return true;
	});
}

export interface SourceMembershipRow {
	client_host: string | null;
	path: string;
	info_hash: string | null;
	ensemble: string;
	element: string;
	selection_order: number;
	origin_id: string;
}
export function sourceMembershipQuery(
	db: Knex,
): Knex.QueryBuilder<SourceMembershipRow, SourceMembershipRow[]> {
	return db<SourceMembershipRow>("ensemble_membership as m")
		.join("physical_path as p", "p.id", "m.path_id")
		.join("source_origin as o", "o.id", "m.origin_id")
		.join("source_namespace as ns", "ns.id", "o.namespace_id")
		.where("ns.enabled", 1)
		.where("o.visible", 1)
		.whereIn("o.state", ["verified", "legacy-unknown"])
		.select(
			db.raw("json_extract(o.metadata, '$.clientHost') AS client_host"),
			"p.path",
			db.raw("json_extract(o.metadata, '$.infoHash') AS info_hash"),
			"m.ensemble",
			"m.element",
			"m.selection_order",
			"m.origin_id",
		) as Knex.QueryBuilder<SourceMembershipRow, SourceMembershipRow[]>;
}

const clientSourceLocators = new Map<string, string>();
/** Bind configured transport identity without credentials or presentation labels. */
export function bindClientSourceLocator(host: string, url: string): void {
	clientSourceLocators.set(host, normalizeSourceLocator("client", url));
}
export function clientSourceLocator(host: string): string {
	return clientSourceLocators.get(host) ?? host;
}

/** Read generation provenance without creating an origin for an uncommitted scan. */
export async function findSourceOrigin(
	db: Knex,
	namespaceId: string,
	key: string,
): Promise<SourceOrigin | undefined> {
	const alias = await db<{
		namespace_id: string;
		alias: string;
		origin_id: string;
	}>("source_alias")
		.where({ namespace_id: namespaceId, alias: key })
		.first();
	return alias
		? db<SourceOrigin>("source_origin")
				.where({ id: alias.origin_id })
				.first()
		: db<SourceOrigin>("source_origin")
				.where({ namespace_id: namespaceId, source_key: key })
				.whereNot("state", "superseded")
				.first();
}
