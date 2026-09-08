import { realpathSync } from "node:fs";
import { commandPathValue, mergeEnvironment, resolveCommandPath } from "./command.js";
import { LspClient } from "./lsp-client.js";
import type { LspServerAdapter } from "./types.js";

export const sessionClientPool = Symbol("lsp-session-client-pool");

type Slot = { tail: Promise<void>; client?: LspClient; fingerprint?: string };

/** In-process resources owned by one Pi session, never shared through the UI. */
export class LspClientPool {
	#slots = new Map<string, Slot>();
	#closing?: Promise<void>;

	async run<T>(
		adapter: LspServerAdapter,
		root: string,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		operation: (client: LspClient) => Promise<T>,
	): Promise<T> {
		this.#assertOpen(signal);
		const cwd = realpathSync(root);
		const key = JSON.stringify([cwd, adapter.name]);
		let slot = this.#slots.get(key);
		if (!slot) {
			slot = { tail: Promise.resolve() };
			this.#slots.set(key, slot);
		}
		const owned = slot;
		const predecessor = owned.tail;
		const task = (async () => {
			await waitForTurn(predecessor, timeoutMs, signal);
			this.#assertOpen(signal);
			const fingerprint = JSON.stringify(
				stable({
					command: resolveCommandPath(
						adapter.defaultCommand.command,
						cwd,
						process.platform,
						commandPathValue(adapter.env),
					),
					args: adapter.defaultCommand.args,
					env: mergeEnvironment(adapter.env),
					initialization: adapter.initialization,
					timeoutMs,
					diagnosticsSettleMs: adapter.diagnosticsSettleMs,
					pushDiagnosticsGraceMs: adapter.pushDiagnosticsGraceMs,
					pullDiagnosticsGraceMs: adapter.pullDiagnosticsGraceMs,
				}),
			);
			if (owned.client && owned.fingerprint !== fingerprint) {
				await owned.client.shutdown();
				owned.client = undefined;
				this.#assertOpen(signal);
			}
			const fresh = !owned.client;
			const client = owned.client ?? new LspClient(adapter, adapter.defaultCommand, cwd, timeoutMs);
			owned.client = client;
			owned.fingerprint = fingerprint;
			const abort = () => client.close();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				this.#assertOpen(signal);
				if (fresh) {
					await client.start();
					this.#assertOpen(signal);
					await client.initialize(cwd);
					this.#assertOpen(signal);
				}
				const result = await operation(client);
				this.#assertOpen(signal);
				return result;
			} catch (error) {
				owned.client = undefined;
				client.close();
				await client.shutdown();
				throw error;
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		})();
		owned.tail = Promise.allSettled([predecessor, task]).then(() => {});
		return task;
	}

	close(): Promise<void> {
		if (!this.#closing) {
			this.#closing = Promise.resolve().then(async () => {
				await Promise.all(
					[...this.#slots.values()].map(async (slot) => {
						slot.client?.close();
						await slot.tail;
						await slot.client?.shutdown();
					}),
				);
				this.#slots.clear();
			});
		}
		return this.#closing;
	}

	#assertOpen(signal?: AbortSignal) {
		if (this.#closing) throw new Error("LSP session is closing; request aborted.");
		signal?.throwIfAborted();
	}
}

function waitForTurn(previous: Promise<void>, timeoutMs: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const finish = (error?: unknown) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve();
		};
		const abort = () => finish(signal?.reason ?? new Error("LSP queued request aborted."));
		const timer = setTimeout(() => finish(new Error("LSP queued request timed out.")), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		void previous.then(() => finish());
	});
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, stable(item)]),
		);
	}
	return value;
}
