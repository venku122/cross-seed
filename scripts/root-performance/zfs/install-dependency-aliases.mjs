import {
	readFileSync,
	mkdirSync,
	symlinkSync,
	lstatSync,
	readlinkSync,
} from "node:fs";
import { dirname } from "node:path";
for (const alias of JSON.parse(readFileSync(process.argv[2], "utf8"))) {
	if (
		!alias.destination.endsWith("/node_modules") ||
		!alias.target.startsWith("/opt/root-performance/dependencies/") ||
		alias.destination.includes("/../")
	)
		throw new Error("Invalid dependency alias");
	if (alias.destination === alias.target) continue;
	const existing = lstatSync(alias.destination, { throwIfNoEntry: false });
	if (
		existing?.isSymbolicLink() &&
		readlinkSync(alias.destination) === alias.target
	)
		continue;
	if (existing)
		throw new Error("Existing dependency alias target must be reviewed");
	mkdirSync(dirname(alias.destination), { recursive: true });
	symlinkSync(alias.target, alias.destination, "dir");
}
