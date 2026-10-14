// Out-of-cgroup control plane for the separate HTTP load generator.
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
let generator;
const server = createServer(async (req, res) => {
	try {
		let body = "";
		for await (const chunk of req) body += chunk;
		const input = body ? JSON.parse(body) : {};
		let output;
		if (req.url === "/arm" && !generator) {
			const target = new URL(input.url);
			if (
				!["127.0.0.1", "localhost", "host.docker.internal"].includes(
					target.hostname,
				)
			)
				throw new Error("Nonlocal load target");
			generator = fork(
				new URL("./loadgen.mjs", import.meta.url),
				[
					input.url,
					String(process.env.PING_RATE ?? 200),
					String(process.env.PING_TIMEOUT ?? 2000),
				],
				{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
			);
			[output] = await once(generator, "message");
		} else if (req.url === "/begin" && generator) {
			const reply = once(generator, "message");
			generator.send({ type: "begin" });
			[output] = await reply;
		} else if (req.url === "/stop" && generator) {
			const reply = once(generator, "message");
			generator.send({ type: "stop" });
			[output] = await reply;
		} else {
			res.statusCode = 400;
			output = { error: true };
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(output));
	} catch {
		res.statusCode = 500;
		res.end('{"error":true}');
	}
});
server.listen(
	Number(process.env.CONTROL_PORT ?? 0),
	process.env.CONTROL_BIND ?? "127.0.0.1",
	() => {
		const output = {
			type: "ready",
			origin: `http://127.0.0.1:${server.address().port}`,
		};
		if (process.send) process.send(output);
		else console.log(JSON.stringify(output));
	},
);
function close() {
	generator?.kill();
	server.closeAllConnections();
	server.close(() => process.exit(0));
}
process.on("disconnect", close);
process.on("SIGTERM", close);
