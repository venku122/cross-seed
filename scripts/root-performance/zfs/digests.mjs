import { createHash } from "node:crypto";
function normalize(value) {
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, normalize(value[key])]),
		);
	return value;
}
const digest = () => createHash("sha256");
export async function cacheSemanticDigest(db) {
	const hash = digest();
	let rows = 0;
	for (let offset = 0; ; offset += 512) {
		const page = await db("client_searchee")
			.select(
				"client_host",
				"info_hash",
				"name",
				"title",
				"files",
				"length",
				"save_path",
				"category",
				"tags",
				"trackers",
			)
			.orderBy("client_host")
			.orderBy("info_hash")
			.limit(512)
			.offset(offset);
		if (!page.length) break;
		for (const row of page) {
			const value = { ...row };
			for (const field of ["files", "tags", "trackers"])
				if (typeof value[field] === "string")
					value[field] = JSON.parse(value[field]);
			hash.update(JSON.stringify(normalize(value)) + "\n");
			rows++;
		}
	}
	return { rows, digest: hash.digest("hex") };
}
export async function visibleMembershipDigests(db, ownedQuery) {
	const base = () =>
		ownedQuery
			? db().from(ownedQuery(db).as("active_memberships"))
			: db("ensemble");
	const columns = ["client_host", "path", "info_hash", "ensemble", "element"];
	const semantic = digest(),
		selection = digest();
	let visibleRows = 0,
		distinctTuples = 0;
	for (let offset = 0; ; offset += 512) {
		const query = base().select(...columns);
		if (ownedQuery)
			query
				.orderBy("selection_order")
				.orderBy("origin_id")
				.orderBy("path")
				.orderBy("ensemble")
				.orderBy("element");
		else query.orderByRaw("rowid");
		const page = await query.limit(512).offset(offset);
		if (!page.length) break;
		for (const row of page) {
			selection.update(JSON.stringify(normalize(row)) + "\n");
			visibleRows++;
		}
	}
	for (let offset = 0; ; offset += 512) {
		const query = base().distinct(...columns);
		for (const field of columns) query.orderBy(field);
		const page = await query.limit(512).offset(offset);
		if (!page.length) break;
		for (const row of page) {
			semantic.update(JSON.stringify(normalize(row)) + "\n");
			distinctTuples++;
		}
	}
	return {
		visibleRows,
		distinctTuples,
		semanticDigest: semantic.digest("hex"),
		selectionDigest: selection.digest("hex"),
	};
}
