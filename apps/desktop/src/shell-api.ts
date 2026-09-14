/**
 * The version of the API the shell exposes to the web bundle through the
 * preload (`window.papercutShell`).
 *
 * Bump it whenever the preload's surface changes in a way a bundle could come
 * to depend on. A bundle's manifest names the lowest version it needs
 * (`minShellApi`), and a shell older than that keeps its current bundle rather
 * than loading one that would call into an API it lacks — that check is what
 * lets the web bundle update without the shell (docs/decision-log.md,
 * "Web bundles are signed downloads, applied through a reload prompt").
 */
export const SHELL_API_VERSION = 1

/** What the preload puts on `window.papercutShell`. */
export interface ShellApi {
  readonly apiVersion: number
  readonly platform: NodeJS.Platform
}
