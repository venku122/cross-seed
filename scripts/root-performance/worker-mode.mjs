export function workerEnvironment(environment, phase, candidateWorker) {
	if (!["A1", "B", "A2"].includes(phase))
		throw new Error("Invalid A/B/A phase");
	const output = { ...environment };
	delete output.CROSS_SEED_SQLITE_WORKER;
	if (candidateWorker && phase === "B") output.CROSS_SEED_SQLITE_WORKER = "1";
	return output;
}
export function workerDockerFlags(phase, candidateWorker) {
	const environment = workerEnvironment({}, phase, candidateWorker);
	// An explicit empty value also neutralizes an inherited image ENV on baselines.
	return [
		"--env",
		`CROSS_SEED_SQLITE_WORKER=${environment.CROSS_SEED_SQLITE_WORKER ?? ""}`,
	];
}
