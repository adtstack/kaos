export class HeadlessFileManager {
	constructor(private readonly vault: { trash(file: unknown, system?: boolean): Promise<void>; rename(file: unknown, path: string): Promise<void> }) {}

	async trashFile(file: unknown): Promise<void> {
		await this.vault.trash(file, true);
	}

	async renameFile(file: unknown, newPath: string): Promise<void> {
		await this.vault.rename(file, newPath);
	}
}

