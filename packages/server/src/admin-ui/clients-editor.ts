// The configuration editor as it exists today (MCP bearer, log limits, pending AI proposal, Clients and their projects), kept
// working under the Clients destination and rebuilt only from UI.* components. Fields autosave after a short pause; there is no
// Save button. The Server is the authority on validity, the page only shows what it answers. Task #79/#80 replace these forms.
export const EDITOR_JS = `
const DEBOUNCE_MS = 500;
let model = { clients: [], logging: { max_bytes: 0, retention_days: 0 } };
let timer = null;
let saving = Promise.resolve();
const lines = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

function schedule() {
  say("editing", "Editing…");
  clearTimeout(timer);
  timer = setTimeout(save, DEBOUNCE_MS);
}

function save() {
  clearTimeout(timer);
  saving = saving.then(async () => {
    say("saving", "Saving…");
    const bearerBox = document.getElementById("bearer");
    const edit = { logging: model.logging, clients: model.clients.map(({ has_public_key, ...c }) => c) };
    if (bearerBox && bearerBox.value) edit.mcp_bearer = bearerBox.value;
    const r = await api("PUT", "/admin/api/config", edit);
    if (r.ok) { if (bearerBox) bearerBox.value = ""; say("saved", "Autosaved · " + clock()); }
    else say("error", "Not saved: " + (r.json.problems || ["unexpected error"]).join("; "));
  });
  return saving;
}

const field = (label, value, onInput, type) => UI.field(label, UI.input({ type, value, onInput: (v) => { onInput(v); schedule(); } }));

function projectCard(client, project, redraw) {
  return UI.card({ variant: "inset", children: [
    UI.el("div", { className: "form-grid" },
      field("Project", project.project_id, (v) => (project.project_id = v)),
      UI.field("Root on the Client host", UI.input({ kind: "path", value: project.physical_root, onInput: (v) => { project.physical_root = v; schedule(); } })),
      UI.field("Mode", UI.select([["read_only", "read only"], ["read_write", "read write"]], project.mode, (v) => { project.mode = v; schedule(); })),
      field("Writable globs", (project.writable_globs || []).join(", "), (v) => (project.writable_globs = lines(v))),
      field("Extra deny globs", (project.deny_globs || []).join(", "), (v) => (project.deny_globs = lines(v)))),
    UI.button("Remove project", { variant: "danger", onClick: () => { client.projects.splice(client.projects.indexOf(project), 1); redraw(); schedule(); } })] });
}

function clientCard(client, redraw) {
  return UI.card({ icon: "users", title: client.client_id || "new Client", children: [
    UI.el("div", { className: "form-grid" },
      field("Client id", client.client_id, (v) => (client.client_id = v)),
      field("Name", client.display_name || "", (v) => (client.display_name = v || undefined))),
    UI.el("div", { className: "actions" },
      UI.toggle("enabled", client.enabled, (v) => { client.enabled = v; schedule(); }),
      client.has_public_key ? UI.pill("enrolled", "ok") : UI.pill("not enrolled yet", "warn")),
    ...client.projects.map((p) => projectCard(client, p, redraw)),
    UI.el("div", { className: "actions" },
      UI.button("Add project", { onClick: () => { client.projects.push({ project_id: "", physical_root: "", mode: "read_only" }); redraw(); schedule(); } }),
      UI.button("Remove Client", { variant: "danger", onClick: () => { model.clients.splice(model.clients.indexOf(client), 1); redraw(); schedule(); } }))] });
}

async function proposalCard(box) {
  const { proposal } = (await api("GET", "/admin/api/proposal")).json;
  if (!proposal) return box.replaceChildren();
  const decide = (action) => async () => {
    const r = await api("POST", "/admin/api/proposal/" + encodeURIComponent(proposal.proposal_id) + "/" + action);
    if (r.ok) say("saved", "Proposal " + r.json.status + " · " + clock());
    else say("error", "Proposal " + r.json.status + (r.json.problems ? ": " + r.json.problems.join("; ") : ""));
    await proposalCard(box);
  };
  box.replaceChildren(UI.card({ icon: "bolt", title: "Pending AI proposal " + proposal.proposal_id, subtitle: "from " + proposal.created_at, children: [
    UI.table(["Setting", "Before", "After"], proposal.diff.map((d) => [d.path, d.before ?? "(none)", d.after ?? "(none)"])),
    UI.el("div", { className: "actions" }, UI.button("Approve", { variant: "primary", onClick: decide("approve") }), UI.button("Reject", { onClick: decide("reject") }))] }));
}

async function renderClients(view) {
  const [state, config] = await Promise.all([api("GET", "/admin/api/state"), api("GET", "/admin/api/config")]);
  model = { clients: config.json.clients, logging: config.json.logging };
  const list = UI.el("div", { className: "stack" });
  const redraw = () => list.replaceChildren(...model.clients.map((c) => clientCard(c, redraw)));
  redraw();
  const proposalBox = UI.el("div");
  view.replaceChildren(
    ...(state.json.setup_mode ? [UI.el("div", { className: "view-banner" }, UI.el("strong", { textContent: "Setup mode. " }), "No configuration is active, so ChatGPT and Clients are refused. Set an MCP bearer and add Clients below; the first valid state activates itself.")] : []),
    UI.card({ icon: "file", title: "MCP bearer", children: [
      UI.input({ id: "bearer", type: "password", placeholder: "leave empty to keep the current one", onInput: schedule }),
      UI.el("span", { className: "hint", textContent: "At least 16 characters, no spaces. Only its digest is stored and it is never shown again." })] }),
    UI.card({ icon: "file", title: "Logs and audit", children: [UI.el("div", { className: "form-grid" },
      UI.field("Largest file, bytes", UI.input({ id: "log-bytes", type: "number", value: model.logging.max_bytes, onInput: (v) => { model.logging.max_bytes = Number(v); schedule(); } })),
      UI.field("Days to keep", UI.input({ id: "log-days", type: "number", value: model.logging.retention_days, onInput: (v) => { model.logging.retention_days = Number(v); schedule(); } })))] }),
    proposalBox, list,
    UI.el("div", { className: "actions" }, UI.button("Add Client", { onClick: () => { model.clients.push({ client_id: "", enabled: false, projects: [], has_public_key: false }); redraw(); schedule(); } })));
  await proposalCard(proposalBox);
  every(() => proposalCard(proposalBox));
}
`;
