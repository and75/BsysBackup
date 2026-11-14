// Avvia l'app impacchettata e controlla, via Chrome DevTools Protocol, che finestra, preload,
// IPC e script dell'interfaccia funzionino davvero. Uso: node scripts/smoke-packaged.js <eseguibile> [argomenti]
const { spawn } = require("node:child_process");

const [exe, ...extraArgs] = process.argv.slice(2);
const port = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === "page" && p.url.includes("index.html"));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("La finestra dell'app non è comparsa entro 30 secondi");
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onerror = () => reject(new Error("Connessione DevTools non riuscita"));
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (msg) => {
      const reply = JSON.parse(msg.data);
      if (reply.id !== 1) return;
      ws.close();
      if (reply.result.exceptionDetails) reject(new Error(JSON.stringify(reply.result.exceptionDetails)));
      else resolve(reply.result.result.value);
    };
  });
}

async function main() {
  const app = spawn(exe, [`--remote-debugging-port=${port}`, ...extraArgs], { stdio: "ignore" });
  try {
    const page = await findPage();
    await sleep(1000);
    const result = await evaluate(
      page.webSocketDebuggerUrl,
      `(async () => {
        const jobs = await window.api.listJobs();
        const home = document.querySelector("h1")?.textContent;
        [...document.querySelectorAll("button")].find((b) => b.textContent === "Nuovo backup").click();
        await new Promise((r) => setTimeout(r, 300));
        return { title: document.title, ipc: Array.isArray(jobs), home, form: document.querySelector("h1")?.textContent };
      })()`
    );
    console.log("Risultato:", JSON.stringify(result));
    if (result.title !== "BsysBackup" || !result.ipc || result.home !== "I tuoi backup" || result.form !== "Nuovo backup") {
      throw new Error("L'app impacchettata non funziona come atteso");
    }
    console.log("OK: finestra aperta, IPC e interfaccia funzionanti");
  } finally {
    app.kill();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
