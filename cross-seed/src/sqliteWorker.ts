import { Worker } from "node:worker_threads";

// Kept inline so packaged distributions and TypeScript test runners use the same
// worker code without a runtime TS loader or a second generated entry point.
const workerSource = `
const {parentPort, workerData} = require('node:worker_threads');
const {DatabaseSync} = require('node:sqlite');
let db;
try {
 db = new DatabaseSync(workerData.filename);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 parentPort.postMessage({id:0, value:true});
} catch (error) { parentPort.postMessage({id:0,error:error.message}); }
parentPort.on('message', ({id,sql,bindings,all,close}) => {
 try {
  if (close) { db.close(); parentPort.postMessage({id,value:true}); return; }
  const statement = db.prepare(sql);
  const value = all ? statement.all(...bindings) : statement.run(...bindings);
  parentPort.postMessage({id,value});
 } catch (error) { parentPort.postMessage({id,error:error.message}); }
});
`;

export class SqliteWorkerConnection {
	private sequence = 0;
	private closed = false;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private constructor(private readonly worker: Worker) {
		worker.on(
			"message",
			(message: { id: number; value?: unknown; error?: string }) => {
				const waiter = this.pending.get(message.id);
				if (!waiter) return;
				this.pending.delete(message.id);
				if (message.error) waiter.reject(new Error(message.error));
				else waiter.resolve(message.value);
			},
		);
		worker.on("error", (error) =>
			this.fail(
				error instanceof Error ? error : new Error(String(error)),
			),
		);
		worker.on("exit", (code) => {
			if (this.pending.size || !this.closed)
				this.fail(new Error(`SQLite worker exited (${code})`));
		});
	}
	private fail(error: Error): void {
		this.closed = true;
		for (const waiter of this.pending.values())
			waiter.reject(
				error instanceof Error ? error : new Error(String(error)),
			);
		this.pending.clear();
	}
	static async open(filename: string): Promise<SqliteWorkerConnection> {
		const worker = new Worker(workerSource, {
			eval: true,
			workerData: { filename },
		});
		const connection = new SqliteWorkerConnection(worker);
		try {
			await new Promise((resolve, reject) =>
				connection.pending.set(0, { resolve, reject }),
			);
			return connection;
		} catch (error) {
			await worker.terminate();
			throw error;
		}
	}
	private send(payload: Record<string, unknown>): Promise<unknown> {
		if (this.closed)
			return Promise.reject(
				new Error("SQLite worker connection is closed"),
			);
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.worker.postMessage({ id, ...payload });
			} catch (error) {
				this.pending.delete(id);
				reject(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		});
	}
	execute(sql: string, bindings: unknown[], all: boolean): Promise<unknown> {
		return this.send({
			sql,
			bindings: bindings.map((value) =>
				typeof value === "boolean" ? Number(value) : value,
			),
			all,
		});
	}
	async close(): Promise<void> {
		if (this.closed) return;
		try {
			await this.send({ close: true });
		} finally {
			this.closed = true;
			await this.worker.terminate();
		}
	}
}
