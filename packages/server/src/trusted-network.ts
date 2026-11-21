// The trusted-network test for first enrollment. The allowed sources are a deployment value (a comma-separated list of
// addresses or CIDRs passed on the command line); nothing here is a built-in range, so an empty list admits nobody.
// The address checked is the direct socket peer, never a forwarded header.
import { BlockList, isIP } from "node:net";

export type SourcePolicy = (address: string | undefined) => boolean;

export const NO_TRUSTED_SOURCES: SourcePolicy = () => false;

const unmap = (address: string): string => (address.toLowerCase().startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address);

/** Parses `a.b.c.d/n`, `x::/n` or single addresses, comma separated; throws on anything else. */
export function parseTrustedSources(spec: string): SourcePolicy {
  const list = new BlockList();
  for (const entry of spec.split(",").map((e) => e.trim()).filter(Boolean)) {
    const parts = entry.split("/");
    if (parts.length > 2) throw new RangeError("invalid trusted source entry");
    const [address = "", prefix] = parts;
    const family = isIP(address);
    if (family === 0) throw new RangeError("invalid trusted source entry");
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(address, type);
    else if (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)) list.addSubnet(address, Number(prefix), type);
    else throw new RangeError("invalid trusted source prefix");
  }
  return (address) => {
    if (!address) return false;
    const ip = unmap(address);
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 4 ? "ipv4" : "ipv6");
  };
}
