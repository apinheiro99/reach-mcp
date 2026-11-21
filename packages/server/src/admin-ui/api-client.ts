// The thin browser API client: the one place the page talks to the Server. It holds no state and no policy; it returns what the
// Server answered and the views only render it.
export const API_JS = `
const api = async (method, path, body) => {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
};
`;
