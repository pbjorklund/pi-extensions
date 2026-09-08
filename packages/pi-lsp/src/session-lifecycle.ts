import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LspClientPool, sessionClientPool } from "./client-pool.js";

/** One session's complete tool invocations, including all diagnostics routes. */
export class LspSessionScope {
	#operations = new Map<AbortController, Promise<void>>();
	#closing?: Promise<void>;
	#pool = new LspClientPool();

	assertOpen() {
		if (this.#closing) throw new Error("LSP session is closing; request aborted.");
	}

	context(ctx: ExtensionContext): ExtensionContext {
		// Keep Pi's lazy context getters. Never reach an old UI getter once shutdown starts.
		return Object.create(ctx, {
			[sessionClientPool]: { value: this.#pool },
			ui: {
				get: () => {
					this.assertOpen();
					return ctx.ui;
				},
			},
		});
	}

	async run<T>(caller: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>) {
		this.assertOpen();
		const controller = new AbortController();
		const abort = () => controller.abort(new Error("LSP request aborted."));
		let settle!: () => void;
		this.#operations.set(
			controller,
			new Promise<void>((resolve) => {
				settle = resolve;
			}),
		);
		caller?.addEventListener("abort", abort, { once: true });
		if (caller?.aborted) abort();
		try {
			controller.signal.throwIfAborted();
			const result = await operation(controller.signal);
			controller.signal.throwIfAborted();
			return result;
		} finally {
			caller?.removeEventListener("abort", abort);
			this.#operations.delete(controller);
			settle();
		}
	}

	close(): Promise<void> {
		if (!this.#closing) {
			// Publish the closing state before abort callbacks can reenter this scope.
			this.#closing = Promise.all([
				Promise.allSettled(this.#operations.values()),
				this.#pool.close(),
			]).then(() => {});
			for (const controller of this.#operations.keys()) {
				controller.abort(new Error("LSP session is closing; request aborted."));
			}
		}
		return this.#closing;
	}
}
