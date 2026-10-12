import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../src/trpc/index.js";

const root = await mkdtemp(join(tmpdir(), "health-tests-"));
process.env.CONFIG_DIR = root;
const { db } = await import("../src/db.js");
const { getDefaultRuntimeConfig, createAppDirHierarchy } =
	await import("../src/configuration.js");
const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
const { initializeLogger } = await import("../src/logger.js");
const { setClientsForTesting } =
	await import("../src/clients/TorrentClient.js");
const { createFakeTorrentClientServer, FakeTorrentClient } =
	await import("./support/fakeTorrentClient.js");
const { Action } = await import("../src/constants.js");
const { healthRouter } = await import("../src/trpc/routers/health.js");
const fake = createFakeTorrentClientServer();
let validations = 0;
let failure = false;
let gate: Promise<void> | undefined;
class CountingClient extends FakeTorrentClient {
	override async validateConfig(): Promise<void> {
		validations++;
		if (gate) await gate;
		if (failure) throw new Error("fixture unreachable");
		await fake.server.inject({ method: "GET", url: "/torrents" });
	}
}
const caller = healthRouter.createCaller({
	user: { id: 1, username: "test" },
} as Context);

describe.sequential("health router snapshots", () => {
	beforeAll(async () => {
		createAppDirHierarchy();
		initializeLogger({ verbose: false });
		await db.migrate.latest();
		await mkdir(join(root, "cross-seeds"), { recursive: true });
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			torrentClients: ["qbittorrent:http://fake.local"],
			torrentDir: undefined,
			dataDirs: [],
			linkDirs: [],
		});
		setClientsForTesting([new CountingClient(fake.server)]);
	});
	afterAll(async () => {
		await fake.server.close();
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});
	it("coalesces ten concurrent authenticated full-router snapshots and timestamps actual measurement", async () => {
		const snapshots = await Promise.all(
			Array.from({ length: 10 }, () => caller.get()),
		);
		expect(validations).toBe(1);
		expect(snapshots[0]).toHaveProperty("measuredAt");
		expect(
			snapshots.every(
				(snapshot) =>
					JSON.stringify(snapshot) === JSON.stringify(snapshots[0]),
			),
		).toBe(true);
		expect(snapshots[0].problems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "indexer:none-configured",
					severity: "error",
				}),
			]),
		);
		expect(snapshots[0].diagnostics.db.pageCount).toBeGreaterThan(0);
	});
	it("reuses a fresh snapshot and expires at the sidebar polling interval", async () => {
		const before = validations;
		const first = await caller.get();
		await caller.get();
		expect(validations).toBe(before);
		const clock = vi
			.spyOn(Date, "now")
			.mockReturnValue(Date.now() + 60_001);
		const next = await caller.get();
		clock.mockRestore();
		expect(validations).toBe(before + 1);
		expect(next.measuredAt).not.toBe(first.measuredAt);
	});
	it("invalidates synchronously after configuration changes", async () => {
		const before = validations;
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			torrentClients: ["qbittorrent:http://fake.local"],
			torrentDir: undefined,
			dataDirs: [],
			linkDirs: [],
			action: Action.INJECT,
		});
		const value = await caller.get();
		expect(validations).toBe(before + 1);
		expect(
			value.problems.some(
				(problem) => problem.id === "client:inject-without-clients",
			),
		).toBe(false);
	});
	it("manual refresh bypasses TTL and coalesces concurrent forced requests", async () => {
		const before = validations;
		await Promise.all(Array.from({ length: 10 }, () => caller.refresh()));
		expect(validations).toBe(before + 1);
	});
	it("surfaces client failure with stable identity and retries without waiting for successful TTL", async () => {
		failure = true;
		const value = await caller.refresh();
		expect(value.problems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "client:validation:fake@fake-torrent-client",
					severity: "error",
					details: "fixture unreachable",
				}),
			]),
		);
		failure = false;
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
		const recovered = await caller.get();
		clock.mockRestore();
		expect(
			recovered.problems.some((problem) =>
				problem.id.startsWith("client:validation:"),
			),
		).toBe(false);
	});
	it("does not publish old configuration when settings change during collection", async () => {
		let release!: () => void;
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = caller.refresh();
		await new Promise((resolve) => setImmediate(resolve));
		const before = validations;
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			torrentClients: [],
			torrentDir: undefined,
			dataDirs: [],
			linkDirs: [],
		});
		const newConfigurationWaiter = caller.get();
		await new Promise((resolve) => setImmediate(resolve));
		gate = undefined;
		release();
		const [value, joined] = await Promise.all([
			pending,
			newConfigurationWaiter,
		]);
		expect(joined.problems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "client:inject-without-clients",
				}),
			]),
		);
		expect(validations).toBe(before);
		expect(value.problems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "client:inject-without-clients",
				}),
			]),
		);
		expect(value.measuredAt).toBeGreaterThan(0);
	});

	it("bounds a slow wait and retains its flight so retries cannot duplicate ongoing work", async () => {
		setRuntimeConfig({
			...getDefaultRuntimeConfig(),
			torrentClients: ["qbittorrent:http://fake.local"],
			torrentDir: undefined,
			dataDirs: [],
			linkDirs: [],
		});
		let release!: () => void;
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const before = validations;
		await expect(caller.refresh()).rejects.toThrow("still running");
		const next = caller.refresh();
		await new Promise((resolve) => setImmediate(resolve));
		expect(validations).toBe(before + 1);
		gate = undefined;
		release();
		expect((await next).measuredAt).toBeGreaterThan(0);
		expect(validations).toBe(before + 1);
	}, 20_000);

	it("rejects an old completed sample instead of advertising stale success as fresh", async () => {
		let release!: () => void;
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = caller.refresh();
		await new Promise((resolve) => setImmediate(resolve));
		const clock = vi
			.spyOn(Date, "now")
			.mockReturnValue(Date.now() + 60_001);
		gate = undefined;
		release();
		await expect(pending).rejects.toThrow("freshness limit");
		clock.mockRestore();
		expect((await caller.refresh()).measuredAt).toBeGreaterThan(0);
	});

	it("rejects completion beyond the waiter deadline even when timer delivery is delayed", async () => {
		let release!: () => void;
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = caller.refresh();
		await new Promise((resolve) => setImmediate(resolve));
		const clock = vi
			.spyOn(performance, "now")
			.mockReturnValue(performance.now() + 15_001);
		gate = undefined;
		release();
		try {
			await expect(pending).rejects.toThrow("waiting deadline");
		} finally {
			clock.mockRestore();
		}
	});
	it("protects cached data behind authentication", async () => {
		const anonymous = healthRouter.createCaller({ user: null } as Context);
		await expect(anonymous.get()).rejects.toThrow("UNAUTHORIZED");
		await expect(anonymous.refresh()).rejects.toThrow("UNAUTHORIZED");
	});
});
