export type Child = Node | string | number | null | undefined | false;

type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

/** Crea un elemento. Le chiavi "on…" sono listener, i booleani attributi senza valore, il resto attributi. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const ICON_PATHS = {
  check: ["M5 12l5 5L20 7"],
  warning: ["M12 3l10 18H2L12 3z", "M12 10v5", "M12 18h.01"],
  chevronRight: ["M9 6l6 6-6 6"],
  chevronDown: ["M6 9l6 6 6-6"],
  back: ["M15 6l-6 6 6 6"],
};

export function icon(name: keyof typeof ICON_PATHS, size = 16): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const numberFormat = new Intl.NumberFormat("it-IT");
const timeFormat = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short" });

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function fileCount(value: number): string {
  return `${formatNumber(value)} file`;
}

export function formatBytes(bytes: number): string {
  const units = ["byte", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString("it-IT", { maximumFractionDigits: digits })} ${units[unit]}`;
}

function daysAgo(date: Date): number {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
}

/** "Oggi, 21:14", "Ieri, 21:14", "11 nov, 18:02" */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  const days = daysAgo(date);
  const day = days === 0 ? "Oggi" : days === 1 ? "Ieri" : dayFormat.format(date);
  return `${day}, ${timeFormat.format(date)}`;
}

/** "oggi", "ieri", "3 giorni fa", "l'11 nov" */
export function formatDayRelative(iso: string): string {
  const date = new Date(iso);
  const days = daysAgo(date);
  if (days === 0) return "oggi";
  if (days === 1) return "ieri";
  if (days < 7) return `${days} giorni fa`;
  return `il ${dayFormat.format(date)}`;
}
