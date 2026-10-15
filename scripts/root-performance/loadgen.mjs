// Open-loop schedule: a slow response never reduces the offered request rate.
import { performance } from "node:perf_hooks";
const [url, rateArg = "200", timeoutArg = "2000"] = process.argv.slice(2);
const rate = Number(rateArg),
	timeout = Number(timeoutArg);
if (
	!url ||
	!Number.isFinite(rate) ||
	rate <= 0 ||
	rate > 10000 ||
	!Number.isFinite(timeout) ||
	timeout <= 0
)
	throw new Error("Invalid load settings");
let began,
	ended,
	timer,
	ordinal = 0;
const pending = new Set(),
	samples = [];
function launch(scheduledMs) {
	const start = performance.now();
	const sample = {
		scheduledMs,
		generatorLagMs: Math.max(0, start - began - scheduledMs),
	};
	samples.push(sample);
	const job = (async () => {
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(timeout),
			});
			const body = await response.text();
			sample.outcome =
				response.ok && body === "OK" ? "completed" : "error";
		} catch (error) {
			sample.outcome =
				error.name === "TimeoutError" ? "timeout" : "error";
		}
		sample.latencyMs = performance.now() - start;
		sample.endToEndMs = sample.latencyMs + sample.generatorLagMs;
	})();
	pending.add(job);
	job.finally(() => pending.delete(job));
}
function tick() {
	if (ended !== undefined) return;
	const elapsed = performance.now() - began;
	// Retain every offered slot. Catch-up lag is visible, never silently skipped.
	while ((ordinal * 1000) / rate <= elapsed)
		launch((ordinal++ * 1000) / rate);
	timer = setTimeout(
		tick,
		Math.max(0, (ordinal * 1000) / rate - (performance.now() - began)),
	);
}
process.on("message", async (message) => {
	if (message.type === "begin" && began === undefined) {
		began = performance.now();
		tick();
		process.send({ type: "begun" });
	}
	if (message.type === "stop" && began !== undefined && ended === undefined) {
		ended = performance.now();
		clearTimeout(timer);
		while ((ordinal * 1000) / rate < ended - began)
			launch((ordinal++ * 1000) / rate);
		await Promise.all(pending);
		process.send({
			type: "result",
			rate,
			timeoutMs: timeout,
			activeWindowMs: ended - began,
			drainMs: performance.now() - ended,
			attempts: samples.length,
			completed: samples.filter((s) => s.outcome === "completed").length,
			timeouts: samples.filter((s) => s.outcome === "timeout").length,
			errors: samples.filter((s) => s.outcome === "error").length,
			samples,
		});
	}
});
process.on("disconnect", () => process.exit());
process.send?.({ type: "ready" });
