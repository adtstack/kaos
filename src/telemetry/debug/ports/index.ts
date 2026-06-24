/**
 * Telemetry debug port interfaces.
 *
 * Product runtime can expose KaosDebugPort (safe, read-only capabilities).
 * Mutation harness (Puppeteer) in qa/ has its own unsafe port definitions.
 *
 * This module must never re-export KaosUnsafeQaPort — that interface lives
 * in qa/ and is not part of the telemetry/Observer contract.
 */

export type { KaosDebugPort, EditorBindingHealth, ReceiptSnapshot } from "./kaosDebugPort";
