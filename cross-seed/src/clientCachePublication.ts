import { clientSourceLocator } from "./sourceStore.js";
import type { Knex } from "knex";
import { db } from "./db.js";
import { invalidateHealth } from "./healthGeneration.js";

/** Capture before the remote read, never when its response arrives. */
export interface ClientCacheLease {
	readonly clientHost: string;
	readonly sourceLocator: string;
	readonly sequence: number;
	readonly session: symbol;
}
interface PublicationState {
	sequence: number;
	active: Set<number>;
	oldestActive: number;
	complete: number;
	origins: Map<string, number>;
	aliases: Map<string, Set<string>>;
	tail: Promise<void>;
}
let session = Symbol("client-cache-coordinator");
let restartFence: Promise<void> = Promise.resolve();
const hosts = new Map<string, PublicationState>();
function stateFor(host: string): PublicationState {
	let state = hosts.get(host);
	if (!state) {
		state = {
			sequence: 0,
			active: new Set(),
			oldestActive: Infinity,
			complete: 0,
			origins: new Map(),
			aliases: new Map(),
			tail: Promise.resolve(),
		};
		hosts.set(host, state);
	}
	return state;
}
export function beginClientCacheOperation(
	clientHost: string,
): ClientCacheLease {
	const state = stateFor(clientHost);
	const sequence = ++state.sequence;
	state.active.add(sequence);
	state.oldestActive = Math.min(state.oldestActive, sequence);
	return {
		clientHost,
		sourceLocator: clientSourceLocator(clientHost),
		sequence,
		session,
	};
}
/** Aggregate coordinator counters contain no source identities. */
export function getClientCachePublicationStats(): {
	hosts: number;
	activeLeases: number;
	origins: number;
	aliases: number;
} {
	return [...hosts.values()].reduce(
		(counts, state) => ({
			hosts: counts.hosts + 1,
			activeLeases: counts.activeLeases + state.active.size,
			origins: counts.origins + state.origins.size,
			aliases: counts.aliases + state.aliases.size,
		}),
		{ hosts: 0, activeLeases: 0, origins: 0, aliases: 0 },
	);
}
/** Release at operation completion; only newer revisions needed by active reads remain. */
export function releaseClientCacheOperation(lease: ClientCacheLease): void {
	if (lease.session !== session) return;
	const state = stateFor(lease.clientHost);
	if (
		!state.active.delete(lease.sequence) ||
		lease.sequence !== state.oldestActive
	)
		return;
	state.oldestActive = Infinity;
	for (const sequence of state.active)
		state.oldestActive = Math.min(state.oldestActive, sequence);
	const oldest = state.oldestActive;
	for (const [key, sequence] of state.origins)
		if (sequence <= oldest) state.origins.delete(key);
	for (const [key, group] of state.aliases)
		if (![...group].some((alias) => state.origins.has(alias)))
			state.aliases.delete(key);
}
/** Invalidates responses from a stopped coordinator, including queued work. */
export function restartClientCachePublication(): void {
	session = Symbol("client-cache-coordinator");
	restartFence = Promise.all([
		restartFence,
		...[...hosts.values()].map((state) => state.tail),
	]).then(() => undefined);
	hosts.clear();
}
export async function isClientCacheOperationCurrent(
	lease: ClientCacheLease,
	key: string,
): Promise<boolean> {
	return ordered(lease, (state) =>
		Promise.resolve(accepts(lease, state, key)),
	);
}
export class ClientCacheConcurrencyError extends Error {
	constructor() {
		super(
			"Client metadata changed during refresh; concurrency retries exhausted",
		);
		this.name = "ClientCacheConcurrencyError";
	}
}
async function ordered<T>(
	lease: ClientCacheLease,
	work: (state: PublicationState) => Promise<T>,
): Promise<T> {
	const state = stateFor(lease.clientHost);
	const previous = state.tail;
	let release!: () => void;
	state.tail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await restartFence;
	await previous;
	try {
		return await work(state);
	} finally {
		release();
	}
}
function accepts(
	lease: ClientCacheLease,
	state: PublicationState,
	key: string,
): boolean {
	return (
		lease.session === session &&
		state.active.has(lease.sequence) &&
		lease.sequence >= state.complete &&
		lease.sequence >=
			Math.max(
				state.origins.get(key) ?? 0,
				...[...(state.aliases.get(key) ?? [])].map(
					(alias) => state.origins.get(alias) ?? 0,
				),
			)
	);
}
/** Callback owns one transaction. A failed callback never advances revisions or health. */
export async function publishClientCacheBatch(
	lease: ClientCacheLease,
	keys: string[],
	write: (trx: Knex.Transaction, acceptedKeys: Set<string>) => Promise<void>,
	aliases?: ReadonlyMap<string, readonly string[]>,
): Promise<boolean> {
	return ordered(lease, async (state) => {
		const groups = new Map(
			keys.map((key) => {
				const group = new Set([key, ...(aliases?.get(key) ?? [])]);
				for (const alias of group)
					for (const known of state.aliases.get(alias) ?? [])
						group.add(known);
				return [key, group];
			}),
		);
		const accepted = new Set(
			keys.filter((key) =>
				[...groups.get(key)!].every((alias) =>
					accepts(lease, state, alias),
				),
			),
		);
		if (!accepted.size)
			return keys.length === 0 && lease.session === session;
		await db.transaction(async (trx) => {
			await write(trx, accepted);
			if (lease.session !== session || !state.active.has(lease.sequence))
				throw new ClientCacheConcurrencyError();
		});
		for (const key of accepted) {
			for (const alias of groups.get(key)!) {
				state.origins.set(alias, lease.sequence);
				state.aliases.set(alias, groups.get(key)!);
			}
		}
		invalidateHealth();
		return (
			lease.session === session && accepted.size === new Set(keys).size
		);
	});
}
/** Call only after every metadata batch succeeds. Tombstones retain removal ordering. */
export async function completeClientCacheSnapshot(
	lease: ClientCacheLease,
	remove: (
		trx: Knex.Transaction,
		canRemove: (key: string) => boolean,
	) => Promise<string[]>,
): Promise<boolean> {
	return ordered(lease, async (state) => {
		if (
			lease.session !== session ||
			!state.active.has(lease.sequence) ||
			lease.sequence < state.complete
		)
			return false;
		let accepted = true;
		const removed = await db.transaction(async (trx) => {
			const removed = await remove(trx, (key) => {
				const current = accepts(lease, state, key);
				accepted &&= current;
				return current;
			});
			if (lease.session !== session || !state.active.has(lease.sequence))
				throw new ClientCacheConcurrencyError();
			return removed;
		});
		for (const key of removed) state.origins.set(key, lease.sequence);
		state.complete = lease.sequence;
		if (removed.length) invalidateHealth();
		return lease.session === session && accepted;
	});
}
