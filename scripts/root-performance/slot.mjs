import { mkdirSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
export function claimComparativeSlot(path) {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(
				"Comparative slot occupied; inspect private owner before clearing an interrupted lock",
			);
		throw error;
	}
	writeFileSync(
		join(path, "owner.json"),
		JSON.stringify({ pid: process.pid }),
		{ mode: 0o600 },
	);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		unlinkSync(join(path, "owner.json"));
		rmdirSync(path);
	};
}
