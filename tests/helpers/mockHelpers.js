import { vi } from "vitest";

/**
 * Creates mock Express req/res/next objects.
 * @param {object} reqOverrides - properties merged onto req
 */
export function makeReqRes(reqOverrides = {}) {
  const res = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    sendStatus: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  const req = {
    params: {},
    query: {},
    path: "/",
    ...reqOverrides,
  };
  return { req, res, next: vi.fn() };
}

/**
 * Creates a minimal LokiJS-style collection mock backed by an array.
 * Supports find(), findOne(), and chain().find().simplesort().data().
 */
export function makeChainableCollection(data) {
  const chainObj = {
    find: vi.fn().mockReturnThis(),
    simplesort: vi.fn().mockReturnThis(),
    data: vi.fn().mockReturnValue([...data]),
  };
  return {
    find: vi.fn().mockReturnValue([...data]),
    findOne: vi.fn().mockImplementation((query) => {
      if (!query) return data[0] ?? null;
      return (
        data.find((item) =>
          Object.entries(query).every(([k, v]) => item[k] === v),
        ) ?? null
      );
    }),
    chain: vi.fn().mockReturnValue(chainObj),
  };
}
