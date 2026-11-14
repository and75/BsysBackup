import { join } from "node:path";
import { createJob, setOverride } from "../core/job";
import { previewDiff, runBackup } from "../core/runner";

/**
 * Uso: node dist/cli/backup.js <source> <destinationDefault> [--override rel=dest ...] [--run] [--hash]
 * Senza --run mostra solo l'anteprima del diff.
 */
async function main() {
  const [source, destination, ...rest] = process.argv.slice(2);
  if (!source || !destination) {
    console.error("Uso: backup <source> <destinationDefault> [--override rel=dest] [--run] [--hash]");
    process.exit(1);
  }

  let job = createJob({ name: "cli-job", sourceRoot: source, defaultDestination: destination });

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--override") {
      const [rel, dest] = rest[++i].split("=");
      job = setOverride(job, rel, dest);
    }
    if (rest[i] === "--hash") {
      job = { ...job, verifyWithHash: true };
    }
  }

  const shouldRun = rest.includes("--run");

  if (!shouldRun) {
    const preview = await previewDiff(job);
    console.log(`Nuovi/modificati: ${preview.planned.filter((f) => f.action !== "unchanged").length}`);
    console.log(`Invariati: ${preview.planned.filter((f) => f.action === "unchanged").length}`);
    console.log(`Rimossi dalla sorgente: ${preview.removedFromSource.length}`);
    if (preview.unreachableDestinations.length > 0) {
      console.log(`Destinazioni non raggiungibili: ${preview.unreachableDestinations.join(", ")}`);
    }
    for (const f of preview.planned.filter((f) => f.action !== "unchanged")) {
      console.log(`  [${f.action}] ${f.relPath} -> ${f.destinationRoot}`);
    }
    return;
  }

  const report = await runBackup(job, { reportsDir: join(process.cwd(), "jobs", "reports") });
  console.log(`Copiati: ${report.totalCopied}  Falliti: ${report.totalFailed}  Saltati (dest. irraggiungibile): ${report.totalSkippedUnreachable}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
