/**
 * The stop code riders see on signage, as printed in the GTFS stop name, e.g.
 * "Опера (707)". 0 when the name carries no usable code.
 *
 * The feed sometimes copies a neighbour's name, code included, onto another
 * stop; that stop's own `stop_code` then names it, if no other stop holds it.
 */
export function stopCodeFor(
  stopName: string,
  stopCode: string | null | undefined,
  isTaken: (code: number) => boolean,
): number {
  const match = stopName.match(/\(([\-\d]+)\)/);
  const code = match ? Number(match[1]) : 0;
  if (!code) return 0;
  if (!isTaken(code) || !/^\d+$/.test(stopCode ?? "")) return code;
  const own = Number(stopCode);
  return own && !isTaken(own) ? own : code;
}
