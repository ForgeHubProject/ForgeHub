import { Worker } from "bullmq";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const parsed = new URL(redisUrl);
const connection = {
  host: parsed.hostname,
  port: Number(parsed.port || 6379)
};

const worker = new Worker(
  "diff-jobs",
  async (job) => {
    // Scaffold placeholder. This will call @forgehub/diff-core once persistence is wired.
    console.log(`Processing job ${job.id}`, job.data);
    return { ok: true };
  },
  { connection }
);

worker.on("completed", (job) => {
  console.log(`Job completed: ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`Job failed: ${job?.id}`, err);
});

console.log("ForgeHub diff worker started");
