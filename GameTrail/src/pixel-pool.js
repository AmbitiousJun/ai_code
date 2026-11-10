const { Worker } = require("node:worker_threads");
const { availableParallelism } = require("node:os");

// One outstanding request per replay loop; FIFO gives waiting instances the next slot.
const limit = Math.max(1, Math.min(4, availableParallelism() - 1));
const workers = new Set();
const queue = [];

function dispatch() {
  while (queue.length) {
    let slot = [...workers].find(item => !item.job && !item.closing);
    if (!slot) {
      if (workers.size >= limit) return;
      const worker = new Worker(require.resolve("./pixel-worker"));
      slot = {worker};
      workers.add(slot);
      worker.on("message", ({result, error}) => {
        if (slot.closing) return;
        const job = slot.job;
        slot.job = null;
        worker.unref();
        job.finish(error ? new Error(error) : null, result);
        dispatch();
      });
      worker.on("error", error => {
        slot.closing = true;
        slot.job?.finish(error);
        slot.job = null;
      });
      worker.on("exit", () => {
        workers.delete(slot);
        slot.job?.finish(new Error("截图匹配线程已退出"));
        dispatch();
      });
    }
    const job = queue.shift();
    slot.job = job;
    job.slot = slot;
    slot.worker.ref();
    slot.worker.postMessage(job.input);
  }
}

function scanInWorker(input, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const job = {input, finish(error, result) {
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    }};
    function abort() {
      if (job.slot) {
        job.slot.closing = true;
        job.slot.job = null;
        job.slot.worker.terminate();
      } else {
        queue.splice(queue.indexOf(job), 1);
      }
      job.finish(signal.reason);
    }
    signal?.addEventListener("abort", abort, {once:true});
    queue.push(job);
    dispatch();
  });
}
module.exports = {scanInWorker};
