// Bun types a response body as unknown. These tests read arbitrary JSON and assert on it, so it is any here and only here.
// biome-ignore lint/suspicious/noExplicitAny: a test helper over arbitrary JSON responses
export type Reply = Omit<Response, "json"> & { json(): Promise<any> };

export const call = async (...args: Parameters<typeof fetch>): Promise<Reply> =>
  (await fetch(...args)) as Reply;
