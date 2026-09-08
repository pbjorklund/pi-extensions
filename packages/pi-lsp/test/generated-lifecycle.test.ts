import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	DefaultResourceLoader,
	ExtensionRunner,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { fixture } from "./lifecycle-support.js";

for (const reason of ["reload", "new", "resume", "fork"] as const) {
	test(`generated idle ${reason}: cleanup precedes invalidation and a fresh runtime starts lazily`, async () => {
		const f = fixture();
		const agentDir = path.join(f.root, "agent");
		mkdirSync(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		writeFileSync(
			path.join(agentDir, "pi-lsp.json"),
			JSON.stringify({
				timeout: 1000,
				servers: {
					fixture: {
						command: [f.adapter.defaultCommand.command, ...f.adapter.defaultCommand.args],
						extensions: [".go"],
						env: f.adapter.env,
					},
				},
			}),
		);
		let runner: ExtensionRunner | undefined;
		try {
			const loader = new DefaultResourceLoader({
				cwd: f.root,
				agentDir,
				settingsManager: SettingsManager.inMemory({}),
				additionalExtensionPaths: [path.resolve("packages/pi-lsp/dist/index.ts")],
			});
			const manager = SessionManager.inMemory(f.root);
			const load = async (sessionManager: SessionManager) => {
				await loader.reload();
				const loaded = loader.getExtensions();
				assert.deepEqual(loaded.errors, []);
				return new ExtensionRunner(
					loaded.extensions,
					loaded.runtime,
					f.root,
					sessionManager,
					{} as ModelRegistry,
				);
			};
			runner = await load(manager);
			await runner.emit({ type: "session_start", reason: "startup" });
			assert.equal(f.events().length, 0);
			const context = runner.createContext();
			const tool = runner.getToolDefinition("lsp_diagnostics");
			assert.ok(tool);
			const execute = () =>
				tool.execute("test", { root: f.root, paths: ["main.go"] }, undefined, undefined, context);
			await execute();
			await execute();
			assert.equal(f.events().filter((e) => e.method === "initialize").length, 1);
			await runner.emit({ type: "session_shutdown", reason });
			f.exited();
			assert.deepEqual(
				f
					.events()
					.slice(-3)
					.map((e) => e.method),
				["shutdown", "exit", "exited"],
			);
			runner.invalidate();
			await assert.rejects(async () => execute(), /stale|closing/);
			runner = await load(reason === "reload" ? manager : SessionManager.inMemory(f.root));
			await runner.emit({ type: "session_start", reason });
			assert.equal(f.events().filter((e) => e.method === "initialize").length, 1);
			const next = runner.getToolDefinition("lsp_diagnostics");
			assert.ok(next);
			await next.execute(
				"next",
				{ root: f.root, paths: ["main.go"] },
				undefined,
				undefined,
				runner.createContext(),
			);
			assert.equal(f.events().filter((e) => e.method === "initialize").length, 2);
		} finally {
			await runner?.emit({ type: "session_shutdown", reason: "quit" });
			await f.dispose();
			vi.unstubAllEnvs();
		}
	});
}

for (const kind of ["diagnostics", "fix"] as const) {
	test(`generated ${kind}: installed runner drains active work before stale-context invalidation`, async () => {
		const f = fixture(
			kind === "fix" ? "lifecycle-hang-textDocument/codeAction" : "lifecycle-hang-initialize",
		);
		const agentDir = path.join(f.root, "agent");
		mkdirSync(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		writeFileSync(
			path.join(agentDir, "pi-lsp.json"),
			JSON.stringify({
				timeout: 1_000,
				servers: {
					fixture: {
						command: [f.adapter.defaultCommand.command, ...f.adapter.defaultCommand.args],
						extensions: [".go"],
						env: f.adapter.env,
					},
				},
			}),
		);
		let runner: ExtensionRunner | undefined;
		let invalidated = false;
		try {
			const loader = new DefaultResourceLoader({
				cwd: f.root,
				agentDir,
				settingsManager: SettingsManager.inMemory({}),
				additionalExtensionPaths: [path.resolve("packages/pi-lsp/dist/index.ts")],
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				f.root,
				SessionManager.inMemory(f.root),
				{} as ModelRegistry,
			);
			const errors: unknown[] = [];
			runner.onError((error) => {
				errors.push(error);
			});
			await runner.emit({ type: "session_start", reason: "startup" });
			const ctx = runner.createContext();
			const tool = runner.getToolDefinition(`lsp_${kind}`);
			assert.ok(tool);
			const task = f.track(
				tool.execute(
					"test",
					{ root: f.root, path: "main.go", paths: ["main.go"], write: true },
					f.controller.signal,
					undefined,
					ctx,
				),
			);
			await f.ready(kind === "fix" ? "textDocument/codeAction" : "initialize");
			await runner.emit({ type: "session_shutdown", reason: "reload" });
			f.exited();
			runner.invalidate();
			invalidated = true;
			assert.throws(() => ctx.ui, /stale/);
			await assert.rejects(task, /aborted|cancelled/);
			assert.deepEqual(errors, []);
		} finally {
			f.controller.abort();
			if (runner && !invalidated) await runner.emit({ type: "session_shutdown", reason: "quit" });
			await f.dispose();
			vi.unstubAllEnvs();
		}
	});
}
