import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Settings {
  /** Modello di Ollama scelto per le proposte di riorganizzazione */
  aiModel?: string;
  /** Ultima cartella aperta in Gestione file */
  lastFolder?: string;
}

/** Impostazioni dell'app. Un file assente o illeggibile equivale a nessuna impostazione. */
export async function loadSettings(path: string): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Settings | null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2), "utf-8");
}
