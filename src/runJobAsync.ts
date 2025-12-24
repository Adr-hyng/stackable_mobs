import { system } from "@minecraft/server";

/**
 * Runs a generator function as a job and returns a Promise that resolves when the job completes.
 * The generator function receives a resolve callback and a jobRef object that will contain the job ID.
 * You should call system.clearJob(jobRef.job) and resolve() when done.
 * This matches the pattern used in open_rig_content_handler.ts
 * 
 * @param generator A generator function that receives (resolve, jobRef) parameters
 * @returns A Promise that resolves when the generator calls resolve
 * 
 * @example
 * ```typescript
 * await runJobAsync(function*(resolve, jobRef) {
 *   for (let i = 0; i < 100; i++) {
 *     yield; // Yield control back to the engine
 *     // Do work here
 *   }
 *   system.clearJob(jobRef.job);
 *   resolve(null); // Resolve when done
 * });
 * ```
 */
export function runJobAsync<T = void>(
  generator: (resolve: (value: T) => void, jobRef: { job: number }) => Generator<void, void, unknown>
): Promise<T> {
  return new Promise<T>((resolve) => {
    const jobRef: { job: number } = { job: 0 };
    jobRef.job = system.runJob((function*() {
      const userGen = generator(resolve, jobRef);
      let result = userGen.next();
      while (!result.done) {
        yield;
        result = userGen.next();
      }
    })());
  });
}
