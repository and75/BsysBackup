// Misura quanto costa far elencare a Robocopy un file per riga (serve all'avanzamento) rispetto a /NFL.
// Uso, dopo "npm run build", solo su Windows:  node scripts/bench-robocopy.js [cartella di lavoro] [numero di file]
// Indicando una cartella sul disco esterno si misura la copia verso quel disco.
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { runRobocopy } = require("../dist/core/copier");

if (process.platform !== "win32") {
  console.log("Robocopy esiste solo su Windows: misura saltata.");
  process.exit(0);
}

const workDir = mkdtempSync(join(process.argv[2] ?? tmpdir(), "bsys-bench-"));
const fileCount = Number(process.argv[3] ?? 3000);
const rounds = 3;

async function main() {
  const source = join(tmpdir(), `bsys-bench-src-${process.pid}`);
  for (let i = 0; i < fileCount; i++) {
    const dir = join(source, `d${i % 30}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file${i}.bin`), Buffer.alloc(4096, i % 251));
  }

  const timings = { conElenco: [], senzaElenco: [] };
  for (let round = 0; round < rounds; round++) {
    for (const [name, listFiles] of [["conElenco", true], ["senzaElenco", false]]) {
      const dest = join(workDir, `${name}-${round}`);
      let listed = 0;
      const start = process.hrtime.bigint();
      const result = await runRobocopy(source, dest, [], [], { listFiles, onFile: () => listed++ });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (!result.ok) throw new Error(`Robocopy fallito (codice ${result.exitCode}): ${result.output}`);
      timings[name].push(ms);
      console.log(`${name} giro ${round + 1}: ${ms.toFixed(0)} ms, righe contate ${listed} su ${fileCount} file`);
      rmSync(dest, { recursive: true, force: true });
    }
  }

  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const withList = median(timings.conElenco);
  const withoutList = median(timings.senzaElenco);
  console.log(`Mediana con elenco: ${withList.toFixed(0)} ms — senza elenco: ${withoutList.toFixed(0)} ms — differenza: ${(((withList - withoutList) / withoutList) * 100).toFixed(1)}%`);
  rmSync(source, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
