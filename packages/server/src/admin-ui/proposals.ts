// The proposal review card: what an AI proposed through MCP, one row per independent item, decided one by one. The Server owns the
// items, their ids, statuses and every decision; this view lists what GET /admin/api/proposal answers, sends the human's click to the
// item endpoints and reloads the Server's answer. Approve-all and reject-all are only conveniences over the items still pending. An
// unreadable stored proposal is shown as such, never as "no proposal".
export const PROPOSALS_JS = `
const ITEM_PILL = { pending: ["Pending", "warn", "clock"], approved: ["Approved", "ok", "check"], rejected: ["Rejected", "bad", "ban"] };
const shortValue = (v) => (v === null ? "—" : String(v).length > 60 ? String(v).slice(0, 57) + "…" : String(v));

function renderProposals(host, onApplied) {
  async function decide(path, done) {
    say("saving", "Saving…");
    const r = await api("POST", path);
    if (r.ok) say("saved", done + " · " + clock());
    else say("error", "Not done: " + ((r.json.problems || [r.json.status || "unexpected error"]).join("; ")));
    await refresh();
    await onApplied();
  }

  async function refresh() {
    const r = await api("GET", "/admin/api/proposal");
    if (!r.ok) return;
    const p = r.json.proposal;
    if (r.json.unusable) {
      host.replaceChildren(UI.card({ icon: "info", title: "A stored proposal cannot be read", tone: "bad", subtitle: "It is kept as found and blocks new proposals until a person resolves it.", children: [UI.pill("Unusable", "bad", "ban")] }));
      return;
    }
    if (!p) { host.replaceChildren(); return; }
    const base = "/admin/api/proposal/" + encodeURIComponent(p.proposal_id);
    const pending = p.items.filter((i) => i.status === "pending").length;
    const rows = p.items.map((i) => {
      const [label, tone, icon] = ITEM_PILL[i.status];
      const act = (action, text, variant) => UI.button(text, { variant, onClick: () => decide("/admin/api/proposal/" + encodeURIComponent(p.proposal_id) + "/items/" + encodeURIComponent(i.item_id) + "/" + action, text) });
      return [i.item_id, i.path, shortValue(i.before) + " → " + shortValue(i.after), UI.pill(label, tone, icon),
        i.status === "pending" ? UI.el("div", { className: "pj-actions" }, act("approve", "Approve", "primary"), act("reject", "Reject")) : ""];
    });
    host.replaceChildren(UI.card({ icon: "shield", title: "Pending proposal from MCP", subtitle: pending + " of " + p.items.length + " items await a decision. Nothing applies until you approve it.", variant: "table", children: [
      UI.table(["Item", "Change", "Before → After", "Status", "Decision"], rows),
      pending ? UI.el("div", { className: "pj-actions" }, UI.button("Approve all pending", { onClick: () => decide(base + "/approve", "Approved all pending") }), UI.button("Reject all pending", { onClick: () => decide(base + "/reject", "Rejected all pending") })) : ""] }));
  }

  return { refresh };
}
`;
