import Knex from "knex";

async function up(knex: Knex.Knex): Promise<void> {
	await knex.schema.alterTable("ensemble", (table) => {
		table.index("ensemble", "ensemble_key_index");
	});
}

async function down(knex: Knex.Knex): Promise<void> {
	await knex.schema.alterTable("ensemble", (table) => {
		table.dropIndex("ensemble", "ensemble_key_index");
	});
}

export default { name: "18-ensemble-lookup-index", up, down };
