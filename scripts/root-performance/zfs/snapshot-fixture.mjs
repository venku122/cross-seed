// Read-only private cold snapshot -> pre-serialized qB responses, outside daemon.
import { stageColdInput } from "./cold-copy.mjs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const config = JSON.parse(
	readFileSync(
		process.env.PRIVATE_CONFIG ?? "/snapshot/benchmark-config.json",
		"utf8",
	),
);
if (!Array.isArray(config.clients) || !config.clients.length)
	throw new Error("Private client mapping required");
const directory = await mkdtemp("/tmp/qb-snapshot-");
const input = await stageColdInput(
	process.env.SNAPSHOT_DB ?? "/snapshot/cross-seed.db",
	join(directory, "input.db"),
);
const db = new DatabaseSync(input, { readOnly: true });
// Keep file JSON in SQLite until requested, as qBittorrent does. Large cached
// files must not be decoded into every catalog response or held twice in RAM.
const rows = db
	.prepare(
		"SELECT client_host, info_hash, name, save_path, category, tags, length FROM client_searchee",
	)
	.all();
const detail = db.prepare(
	"SELECT files, trackers FROM client_searchee WHERE client_host = ? AND info_hash = ?",
);
const mapped = new Set(config.clients.map((client) => client.clientHost));
if (rows.some((row) => !mapped.has(row.client_host)))
	throw new Error("Private mapping omits cached client sources");
if (mapped.size !== config.clients.length)
	throw new Error("Duplicate client mapping");
const catalogs = config.clients.map((client) =>
	rows
		.filter((row) => row.client_host === client.clientHost)
		.map((row) => ({
			hash: row.info_hash,
			infohash_v1:
				row.info_hash?.length === 40 ? row.info_hash : undefined,
			infohash_v2:
				row.info_hash?.length === 64 ? row.info_hash : undefined,
			name: row.name,
			save_path: row.save_path,
			category: row.category ?? "",
			tags: JSON.parse(row.tags ?? "[]").join(","),
			total_size: row.length,
			state: "uploading",
		})),
);
const payloads = catalogs.map((rows) => JSON.stringify(rows));
const rpcDelayMs = Number(process.env.RPC_DELAY_MS ?? 0);
if (!Number.isFinite(rpcDelayMs) || rpcDelayMs < 0 || rpcDelayMs > 10000)
	throw new Error("Invalid replay delay");
const counts = {
	rpcReplayDelayMs: rpcDelayMs,
	requests: 0,
	decodedBytes: 0,
	blockedRequests: 0,
	infoRequests: 0,
};
const server = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	if (req.url === "/bench/stats") {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(counts));
		return;
	}
	const match = new URL(req.url, "http://fixture").pathname.match(
		/^\/source\/(\d+)\/api\/v2(\/.*)$/,
	);
	if (!match || !catalogs[Number(match[1])]) {
		res.statusCode = 404;
		res.end("unsupported");
		return;
	}
	if (rpcDelayMs)
		await new Promise((resolve) => setTimeout(resolve, rpcDelayMs));
	const index = Number(match[1]),
		route = match[2],
		params = new URLSearchParams(body),
		catalog = catalogs[index];
	let payload;
	if (route === "/auth/login") {
		payload = "Ok.";
		res.setHeader("set-cookie", "SID=fixture");
	} else if (route === "/app/version") payload = "v5.1.0";
	else if (route === "/torrents/info") {
		counts.infoRequests++;
		payload = params.has("hashes")
			? JSON.stringify(
					catalog.filter((row) =>
						params.get("hashes").split("|").includes(row.hash),
					),
				)
			: payloads[index];
	} else if (route === "/torrents/files")
		payload = JSON.stringify(
			JSON.parse(
				detail.get(config.clients[index].clientHost, params.get("hash"))
					?.files ?? "[]",
			).map((file, fileIndex) => ({
				name: file.path ?? file.name,
				size: file.length,
				index: fileIndex,
				progress: 1,
				priority: 1,
			})),
		);
	else if (route === "/torrents/trackers")
		payload = JSON.stringify(
			JSON.parse(
				detail.get(config.clients[index].clientHost, params.get("hash"))
					?.trackers ?? "[]",
			).map((host) => ({ url: `udp://${host}/announce`, status: 2 })),
		);
	else if (route === "/torrents/properties")
		payload = JSON.stringify(
			catalog.find((row) => row.hash === params.get("hash")) ?? {},
		);
	else {
		counts.blockedRequests++;
		res.statusCode = 405;
		payload = "unsupported";
	}
	counts.requests++;
	counts.decodedBytes += Buffer.byteLength(payload);
	res.setHeader("content-type", "application/json");
	res.end(payload);
});
server.listen(4041, "0.0.0.0");
