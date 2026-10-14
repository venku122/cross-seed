// Fresh source-only copy; never installs or builds inside original checkouts.
import {
	cpSync,
	copyFileSync,
	mkdirSync,
	existsSync,
	readFileSync,
	writeFileSync,
	lstatSync,
	realpathSync,
	readdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join, basename, relative } from "node:path";
import { createHash } from "node:crypto";
const [repository, destination] = process.argv
	.slice(2)
	.map((value) => resolve(value));
if (!repository || !destination || existsSync(destination))
	throw new Error(
		"Usage: prepare-source-image.mjs FROZEN_REPOSITORY FRESH_CONTEXT",
	);
mkdirSync(join(destination, "source"), { recursive: true, mode: 0o700 });
const excluded = (name) =>
	name === "node_modules" ||
	name === "dist" ||
	name === ".git" ||
	name.startsWith(".env") ||
	name.endsWith(".tsbuildinfo") ||
	name.startsWith(".external-worker") ||
	name === ".comparative-slot";
for (const entry of readdirSync(repository)) {
	if (
		![
			"cross-seed",
			"shared",
			"api-types",
			"webui",
			"cross-seed.org",
			"scripts",
			"package.json",
			"package-lock.json",
			"tsconfig.json",
		].includes(entry)
	)
		continue;
	cpSync(join(repository, entry), join(destination, "source", entry), {
		recursive: true,
		filter: (path) =>
			!excluded(basename(path)) && !lstatSync(path).isSymbolicLink(),
	});
}
// Baseline trees need the same caller-owned tooling even when absent there.
const harnessRoot = fileURLToPath(new URL("..", import.meta.url));
cpSync(
	harnessRoot,
	join(destination, "harness", "scripts", "root-performance"),
	{
		recursive: true,
		filter: (path) =>
			!excluded(basename(path)) && !lstatSync(path).isSymbolicLink(),
	},
);
const aliases = [];
for (const entry of [
	"node_modules",
	"cross-seed/node_modules",
	"shared/node_modules",
	"api-types/node_modules",
	"webui/node_modules",
]) {
	const original = join(repository, entry);
	if (existsSync(original) && lstatSync(original).isSymbolicLink())
		aliases.push({
			destination: realpathSync(original),
			target: join("/opt/root-performance/dependencies", entry),
		});
}
writeFileSync(
	join(destination, "dependency-aliases.json"),
	JSON.stringify(aliases),
	{ mode: 0o600 },
);
copyFileSync(
	new URL("./Dockerfile.source", import.meta.url),
	join(destination, "Dockerfile"),
);
const identities = {};
function scan(path) {
	for (const entry of readdirSync(path)) {
		const file = join(path, entry);
		if (lstatSync(file).isDirectory()) scan(file);
		else
			identities[relative(join(destination, "source"), file)] =
				createHash("sha256").update(readFileSync(file)).digest("hex");
	}
}
scan(join(destination, "source"));
const toolingIdentities = {};
function scanTooling(path) {
	for (const entry of readdirSync(path)) {
		const file = join(path, entry);
		if (lstatSync(file).isDirectory()) scanTooling(file);
		else
			toolingIdentities[relative(join(destination, "harness"), file)] =
				createHash("sha256").update(readFileSync(file)).digest("hex");
	}
}
scanTooling(join(destination, "harness"));
writeFileSync(
	join(destination, "tooling-identities.json"),
	JSON.stringify({ identities: toolingIdentities }, null, 2),
	{ mode: 0o600 },
);
writeFileSync(
	join(destination, "source-identities.json"),
	JSON.stringify({ identities, aliases }, null, 2),
	{ mode: 0o600 },
);
console.log(
	JSON.stringify({
		sourceFiles: Object.keys(identities).length,
		lockSha256: identities["package-lock.json"],
		borrowedDependencyAliases: aliases.length,
	}),
);
