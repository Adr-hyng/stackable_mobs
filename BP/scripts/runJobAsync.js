import { system } from "@minecraft/server";
export function runJobAsync(generator) {
    return new Promise((resolve) => {
        const jobRef = { job: 0 };
        jobRef.job = system.runJob((function* () {
            const userGen = generator(resolve, jobRef);
            let result = userGen.next();
            while (!result.done) {
                yield;
                result = userGen.next();
            }
        })());
    });
}
