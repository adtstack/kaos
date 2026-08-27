export const SERVER_VERSION = "0.7.6";

// Compatibility metadata is intentionally explicit so the plugin can reason
// about safe upgrade paths before we add richer release-manifest logic.
export const SERVER_MIN_PLUGIN_VERSION: string | null = "1.9.4";
export const SERVER_RECOMMENDED_PLUGIN_VERSION = "1.10.0";
export const SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN = "0.7.0";
export const SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER = "1.9.4";
// Attachment safety in v4 is not compatible with older clients: v3 clients
// can overwrite independent local binary edits and cannot verify deletedRef.
export const SERVER_MIN_SCHEMA_VERSION = 4;
export const SERVER_MAX_SCHEMA_VERSION = 4;
export const SERVER_MIGRATION_REQUIRED = true;
