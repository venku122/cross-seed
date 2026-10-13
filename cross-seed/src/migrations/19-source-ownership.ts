import type { Knex } from "knex";

async function up(knex: Knex): Promise<void> {
	await knex.transaction(async (trx) => {
		if (!(await trx.schema.hasTable("source_namespace"))) {
			await trx.schema.createTable("source_namespace", (t) => {
				t.string("id").notNullable().primary();
				t.string("type").notNullable();
				t.string("locator").notNullable();
				t.boolean("enabled").notNullable().defaultTo(true);
				t.bigInteger("operation_sequence").notNullable().defaultTo(0);
				t.bigInteger("last_complete_sequence")
					.notNullable()
					.defaultTo(0);
				t.unique(["type", "locator"]);
			});
			await trx.schema.createTable("source_origin", (t) => {
				t.string("id").notNullable().primary();
				t.string("namespace_id")
					.notNullable()
					.references("id")
					.inTable("source_namespace");
				t.string("source_key").notNullable();
				t.bigInteger("revision").notNullable().defaultTo(0);
				t.string("state").notNullable();
				t.boolean("visible").notNullable().defaultTo(true);
				t.text("metadata").notNullable();
				t.unique(["namespace_id", "source_key"]);
				t.unique(["namespace_id", "id"]);
			});
			await trx.schema.createTable("source_alias", (t) => {
				t.string("namespace_id").notNullable();
				t.string("alias").notNullable();
				t.string("origin_id").notNullable();
				t.primary(["namespace_id", "alias"]);
				t.index(
					["origin_id", "namespace_id", "alias"],
					"source_alias_origin_lookup",
				);
				t.foreign(["namespace_id", "origin_id"])
					.references(["namespace_id", "id"])
					.inTable("source_origin");
			});
			await trx.schema.createTable("physical_path", (t) => {
				t.increments("id");
				t.text("path").notNullable().unique();
			});
			await trx.schema.createTable("ensemble_membership", (t) => {
				t.string("origin_id")
					.notNullable()
					.references("id")
					.inTable("source_origin");
				t.integer("path_id")
					.notNullable()
					.references("id")
					.inTable("physical_path");
				t.string("ensemble").notNullable();
				t.string("element").notNullable();
				t.bigInteger("selection_order").notNullable();
				t.primary(["origin_id", "path_id", "ensemble", "element"]);
				t.index(
					["ensemble", "selection_order"],
					"source_membership_lookup",
				);
				t.index("path_id");
				t.index("selection_order", "source_membership_selection");
			});
			await trx.raw(
				"CREATE INDEX source_legacy_client_identity ON source_origin(namespace_id, state, json_extract(metadata, '$.clientHost'), json_extract(metadata, '$.infoHash'))",
			);
		}
		// The migration remains idempotent for disposable audit fixtures.
		if (!(await trx.schema.hasColumn("source_origin", "visible"))) {
			await trx.schema.alterTable("source_origin", (table) => {
				table.boolean("visible").notNullable().defaultTo(true);
			});
		}
		if (
			!(await trx.schema.hasColumn(
				"client_searchee",
				"source_namespace_id",
			))
		) {
			await trx.schema.alterTable("client_searchee", (table) => {
				table
					.string("source_namespace_id")
					.nullable()
					.references("id")
					.inTable("source_namespace");
			});
		}
		// Correlated compatibility readers must seek each path within its owner,
		// rather than scanning every source in that namespace for every cache row.
		await trx.raw(
			"CREATE INDEX IF NOT EXISTS source_origin_data_path ON source_origin(namespace_id, json_extract(metadata, '$.path'), state)",
		);
		await trx.raw(
			"CREATE INDEX IF NOT EXISTS source_origin_torrent_path ON source_origin(namespace_id, json_extract(metadata, '$.torrentFilePath'), state)",
		);
		// Legacy rows cannot prove configured provenance. Keep the untouched old table
		// and preserve null versus empty strings in the explicit unknown source key.
		await trx("source_namespace")
			.insert({
				id: "legacy-unknown",
				type: "legacy-unknown",
				locator: "legacy-unknown",
			})
			.onConflict("id")
			.ignore();
		await trx.raw(`INSERT OR IGNORE INTO source_origin (id, namespace_id, source_key, revision, state, metadata)
 SELECT 'legacy:' || MIN(rowid), 'legacy-unknown', json_array(client_host,info_hash,path), 0, 'legacy-unknown',
 json_object('clientHost',client_host,'infoHash',info_hash,'path',path)
 FROM ensemble GROUP BY client_host,info_hash,path`);
		await trx.raw(
			`INSERT OR IGNORE INTO physical_path (path) SELECT path FROM ensemble WHERE path IS NOT NULL GROUP BY path`,
		);
		await trx.raw(`INSERT OR IGNORE INTO ensemble_membership (origin_id,path_id,ensemble,element,selection_order)
 SELECT o.id,p.id,e.ensemble,e.element,MIN(e.rowid) FROM ensemble e
 JOIN source_origin o ON o.namespace_id='legacy-unknown' AND o.source_key=json_array(e.client_host,e.info_hash,e.path)
 JOIN physical_path p ON p.path=e.path WHERE e.ensemble IS NOT NULL AND e.element IS NOT NULL
 GROUP BY e.client_host,e.info_hash,e.path,e.ensemble,e.element`);
	});
}
function down(knex: Knex): Promise<void> {
	void knex;
	return Promise.reject(
		new Error(
			"Source ownership rollback requires the preserved database and compatible old code; a lossy down migration is prohibited.",
		),
	);
}
export default { name: "19-source-ownership", up, down };
