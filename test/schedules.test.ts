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
  const socket = new PrismSocket(() => { throw new Error("unused"); }, "", "", () => ({}), say => news.push(say));
  const frame = JSON.stringify({ type: "schedules", timeZone: "Asia/Tokyo", rules: [
    { id: "daily", time: "18:00", text: "hello", to: ["onebot:1"] },
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
    clock.mockReturnValue(Date.parse("2026-11-27T09:00:00Z"));
    tick!();
    expect(news).toHaveLength(5);
    (socket as any).receive(JSON.stringify({ type: "schedules", timeZone: "Asia/Tokyo", rules: [] }));
    expect(clear).toHaveBeenCalled();
  } finally {
    socket.stop();
    clock.mockRestore();
    timer.mockRestore();
    clear.mockRestore();
  }
});
