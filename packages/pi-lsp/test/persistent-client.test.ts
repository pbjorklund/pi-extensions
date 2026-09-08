import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { LspClientPool, sessionClientPool } from "../src/client-pool.js";
import { fixture } from "./lifecycle-support.js";

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
