import { guard, init, jobById, navigate, render, setRenderer, state, type View } from "./app.js";
import { h } from "./dom.js";
import { renderDuplicates, renderReorganize, renderSettings } from "./files.js";
import { renderHome } from "./home.js";
import { renderJob } from "./job.js";
import { renderNewJob } from "./newjob.js";
import { renderResult } from "./result.js";

const root = document.getElementById("app") as HTMLElement;

function currentView(): HTMLElement[] {
  const { view } = state;
  if (view.name === "duplicates") return renderDuplicates();
  if (view.name === "reorganize") return renderReorganize();
  if (view.name === "settings") return renderSettings();
  if (view.name === "new") return renderNewJob();
  if (view.name === "result") return renderResult(view.report);
  if (view.name === "job") {
    const job = jobById(view.jobId);
    if (job) return renderJob(job);
  }
  return renderHome();
}

function errorBanner(): HTMLElement | null {
  if (!state.error) return null;
  const dismiss = () => {
    state.error = null;
    render();
  };
  return h("div", { class: "banner", role: "alert" }, h("span", null, state.error), h("button", { type: "button", class: "btn btn-small", onclick: dismiss }, "Chiudi"));
}

function navItem(label: string, target: View, active: boolean, sub = false): HTMLElement {
  return h("button", { type: "button", class: `nav-item${sub ? " nav-sub" : ""}`, "aria-current": active ? "page" : null, onclick: () => navigate(target) }, label);
}

/** Barra laterale: le sezioni dell'app, utilizzabili l'una indipendentemente dall'altra */
function sidebar(): HTMLElement {
  const { name } = state.view;
  return h(
    "nav",
    { class: "sidebar", "aria-label": "Sezioni" },
    h("div", { class: "brand" }, "BsysBackup"),
    navItem("Backup", { name: "home" }, name === "home" || name === "new" || name === "job" || name === "result"),
    h("div", { class: "nav-group" }, "Gestione file"),
    navItem("Rimuovi duplicati", { name: "duplicates" }, name === "duplicates", true),
    navItem("Riorganizza con AI", { name: "reorganize" }, name === "reorganize", true),
    navItem("Impostazioni", { name: "settings" }, name === "settings"),
    window.api.version && h("div", { class: "version" }, `versione ${window.api.version}`)
  );
}

setRenderer(() => {
  const scroll = window.scrollY;
  const [header, ...rest] = currentView();
  const content = h("div", { class: "content" }, header, ...[errorBanner()].filter((el): el is HTMLElement => el !== null), ...rest);
  root.replaceChildren(sidebar(), content);
  window.scrollTo(0, scroll);
});

navigate({ name: "home" });
guard(init)();
