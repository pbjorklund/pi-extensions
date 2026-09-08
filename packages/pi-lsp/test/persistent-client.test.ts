import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, vi } from "vitest";
import { LspClientPool, sessionClientPool } from "../src/client-pool.js";
import { LspClient } from "../src/lsp-client.js";
import { deferred, fixture } from "./lifecycle-support.js";

test("canonical roots reuse clients while different workspaces and pools stay isolated", async () => {
	const f = fixture();
	const pool = new LspClientPool();
	const otherPool = new LspClientPool();
	try {
		const alias = path.join(f.root, "alias");
		symlinkSync(f.root, alias, "dir");
		const other = path.join(f.root, "other");
		mkdirSync(other);
		const use = (owner: LspClientPool, root: string) =>
			owner.run(f.adapter, root, 1000, undefined, async () => {});
		await use(pool, f.root);
		await use(pool, alias);
		assert.equal(f.events().filter((e) => e.method === "initialize").length, 1);
		await use(pool, other);
		await use(otherPool, f.root);
		assert.equal(new Set(f.events().map((e) => e.pid)).size, 3);
		await pool.close();
		await use(otherPool, f.root);
		assert.equal(f.events().filter((e) => e.method === "initialize").length, 3);
	} finally {
		await pool.close();
		await otherPool.close();
		f.exited();
		await f.dispose();
	}
});

for (const field of ["env", "initialization", "args"] as const) {
	test(`effective ${field} replacement drains the previous process before spawning`, async () => {
		const f = fixture();
		const pool = new LspClientPool();
		const use = () => pool.run(f.adapter, f.root, 1000, undefined, async () => {});
		try {
			await use();
			if (field === "env") f.adapter.env = { ...f.adapter.env, FIXTURE_CHANGED: "yes" };
			if (field === "initialization") f.adapter.initialization = { fixture: { changed: true } };
			if (field === "args")
				f.adapter.defaultCommand.args = [...f.adapter.defaultCommand.args, "changed"];
			await use();
			const records = f.events();
			const ready = records.flatMap((e, i) => (e.method === "ready" ? [i] : []));
			assert.equal(ready.length, 2);
			assert.ok(records.findIndex((e) => e.method === "exited") < ready[1]);
			await use();
			assert.equal(f.events().filter((e) => e.method === "initialize").length, 2);
		} finally {
			await pool.close();
			f.exited();
			await f.dispose();
		}
	});
}

for (const phase of ["initialize", "textDocument/diagnostic"] as const) {
	test(`${phase} timeout evicts the failed process and a later call retries`, async () => {
		const f = fixture(`lifecycle-hang-${phase}`);
		const pool = new LspClientPool();
		const context = { ...f.ctx, [sessionClientPool]: pool };
		try {
			await assert.rejects(f.run("diagnostics", { context, timeoutMs: 300 }), /timed out/);
			f.exited();
			f.adapter.defaultCommand.args[1] = "lifecycle-normal";
			await f.run("diagnostics", { context, timeoutMs: 300 });
			assert.equal(f.events().filter((e) => e.method === "initialize").length, 2);
		} finally {
			await pool.close();
			await f.dispose();
		}
	});
}

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
