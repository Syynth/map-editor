/**
 * The gate budget (#10): the whole vitest run must finish inside 15 seconds,
 * or the run fails.
 *
 * "Quickly" is half of "iterate quickly and safely", and a suite that takes
 * four minutes is not a fast loop however much it covers. #10 fixed the
 * per-iteration budget at 15 s cold and asked for it to be enforced by the
 * run rather than watched by a person.
 *
 * This is a vitest `globalSetup`, not a test file, because no single test
 * can see the whole run: files execute in parallel workers, and the last file
 * to START is not the last to finish. `globalSetup` runs once in the main
 * process before the first worker spawns, and its returned teardown runs once
 * after the last worker reports — so the interval between the two is the
 * whole run as a person waiting on it experiences it, transform and import
 * time included. A throw from the teardown fails the run (exit code 1,
 * verified on vitest 5.0.0), which is what makes this a gate rather than a
 * number in a log.
 *
 * The budget is generous against the current run — well under a second on a
 * warm machine — on purpose. It is not a performance regression detector for
 * a single slow test; it is the ceiling the loop must never cross, set where
 * #10 set it. Tighten it here if the ceiling moves, never per test.
 */

const BUDGET_MS = 15_000

export default function setup(): () => void {
  const start = performance.now()
  return () => {
    const elapsed = performance.now() - start
    if (elapsed > BUDGET_MS)
      throw new Error(`gate budget exceeded: the vitest run took ${(elapsed / 1000).toFixed(1)} s against a ${BUDGET_MS / 1000} s ceiling (#10)`)
  }
}
