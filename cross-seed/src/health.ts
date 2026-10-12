import { performance } from "node:perf_hooks";
import { collectDbDiagnostics } from "./diagnostics/db.js";
import { getHealthGeneration } from "./healthGeneration.js";
import { collectProblems } from "./problems.js";

// Match the sidebar's polling cadence. Concurrent tabs share the same sample;
// failures retry sooner, and manual refresh/configuration changes bypass this TTL.
export const HEALTH_TTL_MS = 60_000;
export const HEALTH_ERROR_TTL_MS = 5_000;
const HEALTH_WAIT_MS = 15_000;

async function measureHealth() {
	const measuredAt = Date.now();
	const [problems, db] = await Promise.all([
		collectProblems(),
		collectDbDiagnostics(),
	]);
	return { problems, diagnostics: { db }, measuredAt };
}

type HealthSnapshot = Awaited<ReturnType<typeof measureHealth>>;
let cached:
	| { value: HealthSnapshot; generation: number; expiresAt: number }
	| undefined;
let flight: Promise<HealthSnapshot> | undefined;
let flightGeneration = 0;

async function waitForMeasurement(
	pending: Promise<HealthSnapshot>,
	waitMs: number,
): Promise<HealthSnapshot> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								"Health collection is still running; retry later.",
							),
						),
					waitMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function getHealth(force = false): Promise<HealthSnapshot> {
	const deadline = performance.now() + HEALTH_WAIT_MS;
	for (;;) {
		const generation = getHealthGeneration();
		if (
			!force &&
			cached?.generation === generation &&
			Date.now() < cached.expiresAt
		)
			return cached.value;
		if (!flight) {
			const pending = measureHealth().then((value) => {
				// Changes during collection must not publish a sample from the old config.
				if (generation === getHealthGeneration()) {
					const failed =
						value.problems.some(
							(problem) => problem.severity === "error",
						) ||
						Boolean(
							value.diagnostics.db.error ||
							value.diagnostics.db.dbstatError,
						);
					cached = {
						value,
						generation,
						expiresAt:
							value.measuredAt +
							(failed ? HEALTH_ERROR_TTL_MS : HEALTH_TTL_MS),
					};
				}
				return value;
			});
			flight = pending;
			flightGeneration = generation;
			// A disconnected waiter or timeout never cancels work shared by other tabs,
			// or opens a second flight while existing filesystem/client work is running.
			void pending.then(
				() => {
					if (flight === pending) flight = undefined;
				},
				() => {
					if (flight === pending) flight = undefined;
				},
			);
		}
		const measuredGeneration = flightGeneration;
		const value = await waitForMeasurement(
			flight,
			Math.max(0, deadline - performance.now()),
		);
		if (performance.now() > deadline)
			throw new Error(
				"Health collection exceeded the waiting deadline; retry later.",
			);
		if (measuredGeneration === getHealthGeneration()) {
			if (Date.now() - value.measuredAt >= HEALTH_TTL_MS)
				throw new Error(
					"Health collection exceeded the freshness limit; retry later.",
				);
			return value;
		}
		force = false;
	}
}
