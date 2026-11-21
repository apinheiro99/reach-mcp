// The product assets the admin page serves. The REACH mark is the approved standalone round network-node symbol, copied unchanged
// from docs/screens/07_logo_reach.png; it is read once, here, so the admin handler itself holds no file access.
import { readFileSync } from "node:fs";

export const LOGO_PNG: Buffer = readFileSync(new URL("./reach-logo.png", import.meta.url));
