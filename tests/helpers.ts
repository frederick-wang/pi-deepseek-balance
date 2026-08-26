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

export function freshCtx(mode = "tui", model?: { provider: string }) {
	const log = { status: [] as Array<{ key: string; text: string | undefined }>, notifications: [] as Array<{ message: string; level: string }>, customCalls: 0 };
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
			custom: async (factory: unknown) => {
				log.customCalls += 1;
				(Factory as { last: unknown }).last = factory;
				return undefined;
			},
		},
	};
	return { ctx, log };
}

const Factory = { last: null as unknown };
