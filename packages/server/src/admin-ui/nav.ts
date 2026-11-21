// The one navigation source of the admin UI. The sidebar and the router are both built from this list; no other file may
// declare a menu entry. The order here is the order on screen.
export const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: "home", subtitle: "High-level server, clients and platform status at a glance." },
  { id: "clients", label: "Clients", icon: "users", subtitle: "Clients, their projects and access." },
  { id: "projects", label: "Projects", icon: "layers", subtitle: "Projects exposed through each Client." },
  { id: "system", label: "System", icon: "cog", subtitle: "Server settings and platform configuration." },
  { id: "api", label: "API", icon: "code", subtitle: "Endpoints and connection details." },
  { id: "logs", label: "Logs", icon: "file", subtitle: "Operational and audit records." },
] as const;

export type NavId = (typeof NAV_ITEMS)[number]["id"];
