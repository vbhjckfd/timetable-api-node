import { timingSafeEqual } from "crypto";
import type { Request } from "express";

/**
 * Whether a request comes from our own lad.lviv.ua server, which proves it with
 * the shared INTERNAL_API_KEY in an X-Internal-Key header. The rate limiters
 * key on the caller's address, and every server-rendered page and AI chat
 * lookup leaves through one Cloud Run address: that single bucket emptied all
 * day (1086 of 1106 429s on 2026-10-29 were the frontend's) and the chat told a
 * rider realtime was "overloaded". With no key configured nothing is exempt.
 */
export function isInternalCaller(req: Request, key = process.env.INTERNAL_API_KEY): boolean {
  if (!key) return false;
  const sent = req.headers["x-internal-key"];
  if (typeof sent !== "string") return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
