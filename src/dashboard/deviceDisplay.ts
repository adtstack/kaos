export function formatDashboardDeviceName(
	deviceName: string,
	currentDeviceName: string | null | undefined,
): string {
	const displayName = deviceName.trim();
	if (!displayName) return deviceName;

	const currentName = currentDeviceName?.trim();
	if (currentName && displayName === currentName) {
		return `${displayName} (this device)`;
	}

	return displayName;
}
