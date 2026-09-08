import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { LspClientPool, sessionClientPool } from "../src/client-pool.js";
import { LspClient } from "../src/lsp-client.js";
import { deferred, fixture } from "./lifecycle-support.js";

test("shutdown bounds an unresponsive server independently of diagnostic timeout", async () => {
	const f = fixture("lifecycle-ignore-shutdown");
	const client = new LspClient(f.adapter, f.adapter.defaultCommand, f.root, 20_000);
	let closing: Promise<void> | undefined;
	let timer: NodeJS.Timeout | undefined;
	try {
		await client.start();
		await client.initialize(f.root);
		await f.ready("initialized");
		closing = client.shutdown();
		await Promise.race([
			closing,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("cleanup exceeded its bound")), 1800);
			}),
		]);
		for (const pid of new Set(f.events().map((e) => e.pid)))
			assert.throws(() => process.kill(pid, 0), /ESRCH/);
	} finally {
		clearTimeout(timer);
		client.close();
		await closing;
		await client.shutdown();
		await f.dispose();
	}
});

test("an idle server exit is replaced on the next request", async () => {
	const f = fixture();
	const pool = new LspClientPool();
	const context = { ...f.ctx, [sessionClientPool]: pool };
	try {
		await f.run("diagnostics", { context });
		const client = await pool.run(f.adapter, f.root, 1000, undefined, async (value) => value);
		process.kill(f.events()[0].pid, "SIGTERM");
		await vi.waitFor(() => assert.equal(client.running, false));
		await f.run("diagnostics", { context });
		assert.equal(f.events().filter((e) => e.method === "initialize").length, 2);
	} finally {
		await pool.close();
		await f.dispose();
	}
});

test("idle pool shutdown sends shutdown and exit and is idempotent", async () => {
	const f = fixture();
	const pool = new LspClientPool();
	try {
		await pool.run(f.adapter, f.root, 1000, undefined, async () => {});
		await Promise.all([pool.close(), pool.close()]);
		assert.deepEqual(
			f
				.events()
				.slice(-3)
				.map((e) => e.method),
			["shutdown", "exit", "exited"],
		);
		f.exited();
	} finally {
		await pool.close();
		await f.dispose();
	}
});

test("a queued caller can cancel without interrupting the active client", async () => {
	const f = fixture();
	const pool = new LspClientPool();
	const gate = deferred();
	const ready = deferred();
	const controller = new AbortController();
	const first = pool.run(f.adapter, f.root, 1000, undefined, async () => {
		ready.resolve();
		await gate.promise;
	});
	try {
		await ready.promise;
		const second = pool.run(f.adapter, f.root, 1000, controller.signal, async () => {
			assert.fail("cancelled queued operation ran");
		});
		controller.abort(new Error("queued abort"));
		await assert.rejects(second, /queued abort/);
		assert.ok(!f.events().some((e) => e.method === "exited"));
	} finally {
		gate.resolve();
		await first;
		await pool.close();
		await f.dispose();
	}
});

for (const scenario of ["lifecycle-persistent-push", "lifecycle-persistent-pull"]) {
	test(`${scenario}: bad to fixed refresh uses current document and rejects old versions`, async () => {
		const f = fixture(scenario);
		const pool = new LspClientPool();
		const context = { ...f.ctx, [sessionClientPool]: pool };
		f.adapter.diagnosticsSettleMs = 10;
		try {
			writeFileSync(f.file, "bad\n");
			assert.match((await f.run("diagnostics", { context })).content[0].text, /current error/);
			writeFileSync(f.file, "fixed\n");
			assert.match((await f.run("diagnostics", { context })).content[0].text, /0 diagnostic/);
			assert.equal(f.events().filter((e) => e.method === "initialize").length, 1);
			writeFileSync(f.file, "silent\n");
			if (scenario.endsWith("push")) {
				await assert.rejects(f.run("diagnostics", { context }), /timeout/);
			} else {
				await assert.rejects(f.run("diagnostics", { context }), /full diagnostic/);
			}
		} finally {
			await pool.close();
			await f.dispose();
		}
	});
}
