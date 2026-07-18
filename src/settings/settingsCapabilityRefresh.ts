/**
 * Gates the settings capability probe to one request per visible settings-tab
 * session. `display()` may run many times while controls are edited, so it is
 * not itself a safe indication that the user re-entered the tab.
 */
export class SettingsCapabilityRefreshSession {
	private visible = false;
	private requested = false;
	private inFlight = false;
	private generation = 0;

	get isInFlight(): boolean {
		return this.inFlight;
	}

	get isVisible(): boolean {
		return this.visible;
	}

	beginDisplay(configured: boolean): number | null {
		if (!this.visible) {
			this.visible = true;
			this.requested = false;
			this.inFlight = false;
			this.generation += 1;
		}

		if (!configured || this.requested) return null;

		this.requested = true;
		this.inFlight = true;
		return this.generation;
	}

	complete(generation: number): boolean {
		if (!this.visible || generation !== this.generation) return false;
		this.inFlight = false;
		return true;
	}

	endDisplay(): void {
		if (!this.visible) return;
		this.visible = false;
		this.inFlight = false;
		this.generation += 1;
	}
}
