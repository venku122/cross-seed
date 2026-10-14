// Synthetic read-only qB transport. Runs outside the measured worker/cgroup.
import { createServer } from "node:http";
import { fixtureFileCount } from "./privacy.mjs";
const [countArg = "8194", shape = "observed", aliasesArg = "1"] =
	process.argv.slice(2);
const count = Number(countArg),
	memberships = Number(aliasesArg);
if (
	!Number.isSafeInteger(count) ||
	count < 0 ||
	count > 100000 ||
	![1, 5].includes(memberships)
)
	throw new Error("Invalid fixture dimensions");
const aliases = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
const title =
	aliases
		.slice(0, memberships === 1 ? 1 : memberships - 1)
		.map((alias) => `Review Show ${alias}`)
		.join(" AKA ") + " S01E01.mkv";
const seasonShape = process.env.SEASON_SHAPE ?? "same";
if (!["same", "1-24", "25-72"].includes(seasonShape))
	throw new Error("Invalid season shape");
let seasonGroup = 0,
	seasonMember = 0;
const seasonSize = (group) =>
	seasonShape === "1-24" ? 1 + (group % 24) : 25 + (group % 48);
const catalog = Array.from({ length: count }, (_, index) => {
	const files = fixtureFileCount(index, shape);
	let sourceTitle = title;
	if (seasonShape !== "same") {
		if (seasonMember >= seasonSize(seasonGroup)) {
			seasonGroup++;
			seasonMember = 0;
		}
		const episode = ++seasonMember;
		sourceTitle =
			aliases
				.slice(0, memberships === 1 ? 1 : memberships - 1)
				.map((alias) => `Review Show ${alias} Group ${seasonGroup}`)
				.join(" AKA ") + ` S01E${String(episode).padStart(2, "0")}.mkv`;
	}
	return {
		hash: index.toString(16).padStart(40, "0"),
		infohash_v1: index.toString(16).padStart(40, "0"),
		name: sourceTitle,
		save_path: "/synthetic/root",
		category: "fixture",
		tags: "fixture",
		total_size: 4096 + files - 1,
		state: "uploading",
		trackers: [],
		files: Array.from({ length: files }, (_, file) => ({
			name: file
				? `extra-${String(file).padStart(5, "0")}.mkv`
				: String(index).padStart(9, "0"),
			size: file ? 1 : 4096,
			index: file,
			progress: 1,
			priority: 1,
		})),
	};
});
const full = JSON.stringify(catalog);
const server = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const url = new URL(req.url, "http://localhost");
	const params = new URLSearchParams(body);
	for (const [key, value] of url.searchParams) params.set(key, value);
	const route = url.pathname.replace("/api/v2", "");
	let payload;
	if (route === "/auth/login") {
		payload = "Ok.";
		res.setHeader("set-cookie", "SID=fixture");
	} else if (route === "/app/version") payload = "v5.1.0";
	else if (route === "/torrents/info")
		payload = params.has("hashes")
			? JSON.stringify(
					catalog.filter((t) =>
						params.get("hashes").split("|").includes(t.hash),
					),
				)
			: full;
	else if (route === "/torrents/files")
		payload = JSON.stringify(
			catalog.find((t) => t.hash === params.get("hash"))?.files ?? [],
		);
	else if (route === "/torrents/properties")
		payload = JSON.stringify({ save_path: "/synthetic/root" });
	else if (route === "/torrents/trackers") payload = "[]";
	else {
		res.statusCode = 405;
		payload = "unsupported";
	}
	res.setHeader("content-type", "application/json");
	res.end(payload);
});
server.listen(
	Number(process.env.FIXTURE_PORT ?? 0),
	process.env.FIXTURE_BIND ?? "127.0.0.1",
	() => {
		const ready = {
			type: "ready",
			origin: `http://127.0.0.1:${server.address().port}`,
			sources: count,
			jsonBytes: Buffer.byteLength(full),
		};
		if (process.send) process.send(ready);
		else console.log(JSON.stringify(ready));
	},
);
process.on("disconnect", () => server.close());
