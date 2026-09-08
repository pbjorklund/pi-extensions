import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { LspClientPool, sessionClientPool } from "../src/client-pool.js";
import { deferred, fixture } from "./lifecycle-support.js";

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
