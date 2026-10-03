import { expect, test } from "bun:test";
import { formatDateTime, formatHM, parseDateTime } from "../src/display-time";

test("wire offsets, midnight, seasonal rollback and expiry labels do not depend on the host zone", () => {
  const start = "2026-11-01T01:10:00-04:00", end = "2026-11-01T01:20:00-05:00";
  expect(formatHM("2026-10-03T10:08:00+08:00")).toBe("10:08");
  expect(formatHM("2026-10-03T11:08:00+09:00")).toBe("11:08");
  expect(formatDateTime("2026-10-04T00:10:00+09:00")).toBe("2026/10/04 00:10:00（UTC+09:00）");
  expect(parseDateTime(end)!.getTime() - parseDateTime(start)!.getTime()).toBe(70 * 60_000);
  expect(formatHM(start)).toBe("01:10");
  expect(formatHM(end)).toBe("01:20");
  expect(formatDateTime(null)).toBe("永不过期");
  expect(formatDateTime("invalid")).toBe("时间无效");
});
