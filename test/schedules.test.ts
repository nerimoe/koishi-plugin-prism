import { expect, it, spyOn } from "bun:test";
import { PrismSocket } from "../src";

it("uses shop time and deduplicates a rule after configuration refresh", () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-26T09:00:00Z"));
  let tick: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    tick = callback;
    return 1;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  const news: unknown[] = [];
  const socket = new PrismSocket(() => { throw new Error("unused"); }, "", "", () => ({}), say => { news.push(say); return true; });
  const frame = JSON.stringify({ type: "schedules", timeZone: "Asia/Tokyo", rules: [
    { id: "daily", time: "18:00", additionalTimes: ["19:00"], text: "hello", to: ["onebot:1"] },
    { id: "weekly", time: "18:00", text: "Thursday", weekdays: [4], to: ["onebot:1"] },
    { id: "other", time: "18:00", text: "Friday", weekdays: [5], to: ["onebot:1"] },
    { id: "once", time: "18:00", text: "once", date: "2026-11-26", to: ["onebot:1"] },
  ] });
  try {
    (socket as any).receive(frame);
    tick!();
    expect(news).toHaveLength(3);
    (socket as any).receive(frame);
    tick!();
    expect(news).toHaveLength(3);
    clock.mockReturnValue(Date.parse("2026-11-26T10:00:00Z"));
    tick!();
    expect(news).toHaveLength(4);
    clock.mockReturnValue(Date.parse("2026-11-27T09:00:00Z"));
    tick!();
    expect(news).toHaveLength(6);
    (socket as any).receive(JSON.stringify({ type: "schedules", timeZone: "Asia/Tokyo", rules: [] }));
    expect(clear).toHaveBeenCalled();
  } finally {
    socket.stop();
    clock.mockRestore();
    timer.mockRestore();
    clear.mockRestore();
  }
});

it("retries only failed recipients after one minute and finishes after the second attempt", async () => {
  const attempts: string[] = [];
  const retries: Array<() => void> = [];
  const socket = new PrismSocket(() => { throw new Error("unused"); }, "", "", () => ({}), say => {
    attempts.push(say.to!);
    return say.to === "ok" || (say.to === "recover" && attempts.filter(to => to === "recover").length === 2);
  });
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(60_000);
    retries.push(callback);
    return 1;
  }) as typeof setTimeout);
  try {
    const deliver = (to: string) => (socket as any).sendScheduled({ id: "morning", text: "hello" }, to, "2026-11-27", "09:00");
    for (const to of ["ok", "recover", "fail"]) deliver(to);
    await Promise.resolve();
    expect(retries).toHaveLength(2);
    deliver("fail");
    retries.splice(0).forEach(retry => retry());
    await Promise.resolve();
    for (const to of ["ok", "recover", "fail"]) deliver(to);
    expect(retries).toHaveLength(0);
    expect(attempts).toEqual(["ok", "recover", "fail", "recover", "fail"]);
  } finally {
    timer.mockRestore();
    socket.stop();
  }
});
