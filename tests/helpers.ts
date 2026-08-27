/** Test scaffold: fake pi capturing handlers/commands; fake ctx recording UI calls. */
export function fakePi() {
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
	const commands: Record<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }> = {};
	return {
		handlers,
		commands,
		on(event: string, fn: (event: unknown, ctx: unknown) => unknown) {
			(handlers[event] ??= []).push(fn);
		},
		registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }) {
			commands[name] = options;
		},
		async emit(event: string, payload: unknown, ctx: unknown) {
			for (const fn of handlers[event] ?? []) await fn(payload, ctx);
		},
		async runCommand(name: string, args: string, ctx: unknown) {
			await commands[name]?.handler(args, ctx);
		},
	};
}

export const identityTheme = { fg: (_r: string, t: string) => t };

export interface OverlayArtifact {
	component: { render(width: number): string[]; invalidate(): void; handleInput(data: string): void } | null;
	options: { overlay?: boolean; overlayOptions?: { maxHeight?: string | number } } | null;
	doneCalls: number;
	rows: number;
}

/**
 * Keybindings stub mirroring pi's accepted forms for confirm/cancel and the
 * scroll keys we bind — legacy bytes plus Kitty CSI-u encodings.
 */
export function stubKb(): { matches(data: string, id: string): boolean } {
	const confirm = new Set(["\r", "\n", "\x1b[13u", "\x1bOM"]);
	const cancel = new Set(["\x1b", "\x1b[27u", "\x03", "\x1b[99;5u"]);
	const up = new Set(["\x1b[A", "\x1bOA"]);
	const down = new Set(["\x1b[B", "\x1bOB"]);
	const pageUp = new Set(["\x1b[5~"]);
	const pageDown = new Set(["\x1b[6~"]);
	const home = new Set(["\x1b[H", "\x1b[1~", "\x1bOH"]);
	const end = new Set(["\x1b[F", "\x1b[4~", "\x1bOF"]);
	return {
		matches(data: string, id: string) {
			switch (id) {
				case "tui.select.confirm": return confirm.has(data);
				case "tui.select.cancel": return cancel.has(data);
				case "tui.select.up": return up.has(data);
				case "tui.select.down": return down.has(data);
				case "tui.select.pageUp": return pageUp.has(data);
				case "tui.select.pageDown": return pageDown.has(data);
				case "tui.altScreen.pageUp": return pageUp.has(data);
				case "tui.altScreen.pageDown": return pageDown.has(data);
				case "tui.altScreen.top": return home.has(data);
				case "tui.altScreen.bottom": return end.has(data);
				default: return false;
			}
		},
	};
}

export function freshCtx(mode = "tui", model?: { provider: string }) {
	const log = {
		status: [] as Array<{ key: string; text: string | undefined }>,
		notifications: [] as Array<{ message: string; level: string }>,
		customCalls: 0,
		overlay: null as OverlayArtifact | null,
	};
	const ctx = {
		mode,
		model,
		ui: {
			setStatus: (key: string, text?: string) => {
				log.status.push({ key, text });
			},
			notify: (message: string, level: string) => {
				log.notifications.push({ message, level });
			},
			theme: identityTheme,
			// Real invoker: pi calls the factory with (tui, theme, kb, done) and
			// uses the returned component + options. Mirror that so tests drive
			// the actual component contract.
			custom: async (
				factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => unknown,
				options?: { overlay?: boolean; overlayOptions?: { maxHeight?: string | number } },
			) => {
				log.customCalls += 1;
				const artifact: OverlayArtifact = {
					component: null,
					options: options ?? null,
					doneCalls: 0,
					rows: 24,
				};
				log.overlay = artifact;
				const done = (value: unknown) => {
					void value;
					artifact.doneCalls += 1;
				};
				// The factory receives the ui's live theme — mirror the real call.
				const component = factory({ terminal: { rows: artifact.rows } }, ctx.ui.theme, stubKb(), done) as OverlayArtifact["component"];
				artifact.component = component;
				return undefined;
			},
		},
	};
	return { ctx, log };
}

/** Drive the captured overlay: render + input convenience. */
export function invokeOverlay(log: ReturnType<typeof freshCtx>["log"], width?: number): string[] {
	const comp = log.overlay?.component;
	if (!comp) throw new Error("no overlay captured — did the command reach custom()?");
	return comp.render(width ?? 80);
}

export function press(log: ReturnType<typeof freshCtx>["log"], data: string): void {
	const comp = log.overlay?.component;
	if (!comp) throw new Error("no overlay captured");
	comp.handleInput(data);
}
