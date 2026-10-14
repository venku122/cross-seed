import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	copyFileSync,
	existsSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
const [repository, destination] = process.argv
	.slice(2)
	.map((value) => resolve(value));
if (!repository || !destination || existsSync(destination))
	throw new Error(
		"Usage: prepare-linux-context.mjs REPOSITORY FRESH_DESTINATION",
	);
const pkg = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
const workspaces = Array.isArray(pkg.workspaces)
	? pkg.workspaces
	: pkg.workspaces?.packages;
if (
	!Array.isArray(workspaces) ||
	workspaces.some(
		(path) =>
			path.includes("*") || path.includes("..") || path.startsWith("/"),
	)
)
	throw new Error("Expected explicit safe workspace paths");
mkdirSync(destination, { recursive: true, mode: 0o700 });
const identities = {};
for (const path of [
	"package.json",
	"package-lock.json",
	...workspaces.map((path) => join(path, "package.json")),
]) {
	const output = join(destination, "manifests", path);
	mkdirSync(dirname(output), { recursive: true });
	copyFileSync(join(repository, path), output);
	identities[path] = createHash("sha256")
		.update(readFileSync(output))
		.digest("hex");
}
copyFileSync(
	new URL("./Dockerfile.dependencies", import.meta.url),
	join(destination, "Dockerfile"),
);
writeFileSync(
	join(destination, "manifest-identities.json"),
	JSON.stringify({ node: "v26.11.1", identities }, null, 2),
	{ mode: 0o600 },
);
console.log(
	JSON.stringify({
		lockSha256: identities["package-lock.json"],
		manifests: Object.keys(identities).length,
	}),
);
