import { guard, init, jobById, navigate, render, setRenderer, state } from "./app.js";
import { h } from "./dom.js";
import { renderHome } from "./home.js";
import { renderJob } from "./job.js";
import { renderNewJob } from "./newjob.js";
import { renderResult } from "./result.js";

const root = document.getElementById("app") as HTMLElement;

function currentView(): HTMLElement[] {
  const { view } = state;
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

setRenderer(() => {
  const scroll = window.scrollY;
  const [header, ...rest] = currentView();
  root.replaceChildren(header, ...[errorBanner()].filter((el): el is HTMLElement => el !== null), ...rest);
  window.scrollTo(0, scroll);
});

navigate({ name: "home" });
guard(init)();
