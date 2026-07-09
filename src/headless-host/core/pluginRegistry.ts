export class HeadlessPluginRegistry {
	readonly plugins: Record<string, unknown> = {};
	readonly enabledPlugins = new Set<string>();

	register(id: string, plugin: unknown): void {
		this.plugins[id] = plugin;
		this.enabledPlugins.add(id);
	}

	unregister(id: string): void {
		delete this.plugins[id];
		this.enabledPlugins.delete(id);
	}

	getPlugin(id: string): unknown {
		return this.plugins[id] ?? null;
	}

	async enablePlugin(id: string): Promise<void> {
		if (this.plugins[id]) {
			this.enabledPlugins.add(id);
		}
	}

	async disablePlugin(id: string): Promise<void> {
		this.enabledPlugins.delete(id);
	}
}
