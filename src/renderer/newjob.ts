import { createJob, guard, pickNewJobFolder, state } from "./app.js";
import { h } from "./dom.js";
import { backLink } from "./job.js";

function folderPicker(id: string, label: string, hint: string, field: "sourceRoot" | "defaultDestination"): HTMLElement {
  return h(
    "div",
    { class: "form-row" },
    h("label", { for: id }, label),
    h(
      "div",
      { class: "picker" },
      h("input", { id, type: "text", readonly: true, value: state.newJob[field], placeholder: hint }),
      h("button", { type: "button", class: "btn", onclick: guard(() => pickNewJobFolder(field)) }, "Scegli…")
    )
  );
}

export function renderNewJob(): HTMLElement[] {
  const name = h("input", { id: "new-name", type: "text", value: state.newJob.name, placeholder: "Ad esempio: Backup PC principale" }) as HTMLInputElement;
  name.addEventListener("input", () => {
    state.newJob.name = name.value;
  });

  const form = h(
    "form",
    { class: "panel form" },
    h("div", { class: "form-row" }, h("label", { for: "new-name" }, "Nome"), name),
    folderPicker("new-source", "Cartella da salvare", "Nessuna cartella scelta", "sourceRoot"),
    folderPicker("new-destination", "Dove salvarla", "Nessuna cartella scelta", "defaultDestination"),
    h("p", { class: "muted small" }, "Meglio una cartella dedicata al backup, non la radice di un disco. Dopo la creazione potrai mandare singole sottocartelle su dischi diversi."),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "Crea backup"))
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    guard(createJob)();
  });

  return [h("header", { class: "topbar" }, h("div", { class: "topbar-title" }, backLink(), h("h1", null, "Nuovo backup"))), h("main", { class: "page narrow" }, form)];
}
