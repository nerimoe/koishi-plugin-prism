import { afterEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { applyEvent, attemptOrder, HA_TIMING, HaWatcher, parseWatch, websocketUrl, type EntityState, type HaConnection } from "../src/ha-watch";
import type { SocketFactory } from "../src";

/** A Home Assistant that speaks enough of its WebSocket API: signing in, `subscribe_entities`, and ping. */
function fakeHome(options: { token?: string; answersPings?: boolean } = {}) {
  const token = options.token ?? "reader";
  const sockets = new Set<ServerWebSocket<unknown>>();
  const received: any[] = [];
  let opened = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, bun) {
      return bun.upgrade(request) ? undefined : new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        opened += 1;
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "auth_required", ha_version: "test" }));
      },
      message(ws, raw) {
        const message = JSON.parse(String(raw));
        received.push(message);
        if (message.type === "auth") ws.send(JSON.stringify({ type: message.access_token === token ? "auth_ok" : "auth_invalid" }));
        else if (message.type === "subscribe_entities") {
          ws.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
          ws.send(JSON.stringify({
            id: message.id,
            type: "event",
            event: { a: {
              "switch.a": { s: "on", a: { friendly_name: "A", icon: "x" }, lc: 1000, lu: 1000 },
              "climate.c": { s: "cool", a: { temperature: 24, hvac_modes: ["off", "cool"], noise: 1 }, lc: 1000, lu: 1000 },
            } },
          }));
        } else if (message.type === "ping" && options.answersPings !== false) ws.send(JSON.stringify({ id: message.id, type: "pong" }));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    received,
    open: () => sockets.size,
    opened: () => opened,
    push(event: unknown) {
      for (const ws of sockets) ws.send(JSON.stringify({ id: 1, type: "event", event }));
    },
    dropAll() {
      for (const ws of [...sockets]) ws.close();
    },
    stop() {
      server.stop(true);
    },
  };
}

/** An address that accepts the connection and never says anything: the kind that costs a long wait. */
function blackHole() {
  let accepted = 0;
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { accepted += 1; }, data() {}, close() {} } });
  return { url: `http://127.0.0.1:${server.port}`, accepted: () => accepted, stop: () => server.stop(true) };
}

const real: SocketFactory = (url) => new WebSocket(url) as never;
const fast = { connectMs: 300, authMs: 300, heartbeatMs: 200, firstRetryMs: 40, maxRetryMs: 120 };
const until = async (what: string, done: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function watching(urls: string[], options: { token?: string; term?: number } = {}) {
  const frames: any[] = [];
  const watcher = new HaWatcher(real, (frame) => frames.push(frame), undefined, fast);
  cleanups.push(() => watcher.stop());
  const connection: HaConnection = { id: "ha_1", urls, token: options.token ?? "reader", entities: ["switch.a", "climate.c"] };
  const start = (term = options.term ?? 1) => watcher.watch({ term, connections: [connection] });
  const statuses = () => frames.filter((frame) => frame.method === "ha.status");
  const states = () => frames.filter((frame) => frame.method === "ha.states");
  return { watcher, frames, start, statuses, states };
}

describe("watching Home Assistant", () => {
  it("reports the whole state first and then only what changed, ordered by when it was updated", async () => {
    const home = fakeHome();
    cleanups.push(home.stop);
    const run = watching([home.url]);
    run.start(7);
    await until("the snapshot", () => run.states().length === 1);
    expect(run.statuses()[0]).toEqual({ type: "ha", method: "ha.status", params: { term: 7, connection: "ha_1", connected: true, error: null } });
    const [snapshot] = run.states();
    expect(snapshot.params).toMatchObject({ term: 7, connection: "ha_1", full: true });
    // Only the attributes the platform uses are sent.
    expect(snapshot.params.states).toEqual(expect.arrayContaining([
      { entity_id: "switch.a", state: "on", last_changed: 1000, last_updated: 1000, attributes: {} },
      { entity_id: "climate.c", state: "cool", last_changed: 1000, last_updated: 1000, attributes: { temperature: 24, hvac_modes: ["off", "cool"] } },
    ]));
    expect(home.received.find((message) => message.type === "auth")).toEqual({ type: "auth", access_token: "reader" });
    expect(home.received.find((message) => message.type === "subscribe_entities").entity_ids).toEqual(["switch.a", "climate.c"]);

    // A setting changed: `last_changed` stays, `last_updated` moves, and only that entity is sent.
    home.push({ c: { "climate.c": { "+": { a: { temperature: 26 }, lu: 1002 } } } });
    await until("the change", () => run.states().length === 2);
    expect(run.states()[1].params).toMatchObject({ full: false, states: [{ entity_id: "climate.c", last_changed: 1000, last_updated: 1002, attributes: { temperature: 26, hvac_modes: ["off", "cool"] } }] });

    // Something nobody reads changed: nothing is sent.
    home.push({ c: { "climate.c": { "+": { a: { friendly_name: "Room" }, lu: 1003 } } } });
    await quiet(120);
    expect(run.states().length).toBe(2);

    // An attribute was removed.
    home.push({ c: { "climate.c": { "-": { a: ["temperature"] } } } });
    await until("the removal", () => run.states().length === 3);
    expect(run.states()[2].params.states[0].attributes).toEqual({ hvac_modes: ["off", "cool"] });
  });

  it("uses the next address when the first never answers, and does not call that a lost connection", async () => {
    const home = fakeHome();
    const dead = blackHole();
    cleanups.push(home.stop, dead.stop);
    const run = watching([dead.url, home.url]);
    const started = Date.now();
    run.start();
    await until("a connection", () => run.statuses().length > 0);
    // It waited out the connect timeout on the first address, and said nothing about it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(fast.connectMs - 50);
    expect(run.statuses()[0]!.params.connected).toBe(true);
    expect(run.frames.some((frame) => frame.method === "ha.status" && frame.params.connected === false)).toBe(false);
    await until("the snapshot", () => run.states().length === 1);
  });

  it("starts from the address that worked last, so a dead one costs its wait once", async () => {
    const home = fakeHome();
    const dead = blackHole();
    cleanups.push(home.stop, dead.stop);
    const run = watching([dead.url, home.url]);
    run.start();
    await until("the first snapshot", () => run.states().length === 1);
    expect(dead.accepted()).toBe(1);

    home.dropAll();
    const dropped = Date.now();
    await until("a second snapshot", () => run.states().length === 2);
    // Back well inside one connect timeout, without trying the dead address again.
    expect(Date.now() - dropped).toBeLessThan(fast.connectMs);
    expect(dead.accepted()).toBe(1);
    expect(run.states()[1]!.params.full).toBe(true);
  });

  it("says it is down once every address has had its turn, and names them all", async () => {
    const dead = blackHole();
    cleanups.push(dead.stop);
    const refused = "http://127.0.0.1:1";
    const run = watching([dead.url, refused]);
    const started = Date.now();
    run.start();
    await until("a report", () => run.frames.length > 0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(fast.connectMs - 50);
    expect(run.frames[0]).toMatchObject({ method: "ha.status", params: { connected: false } });
    const error = run.frames[0].params.error as string;
    expect(error).toContain(dead.url);
    expect(error).toContain(refused);
    expect(error).toContain("connecting timed out");
  });

  it("reports a token Home Assistant rejects", async () => {
    const home = fakeHome({ token: "right" });
    cleanups.push(home.stop);
    const run = watching([home.url], { token: "wrong" });
    run.start();
    await until("a report", () => run.frames.length > 0);
    expect(run.frames[0]).toMatchObject({ method: "ha.status", params: { connected: false, error: expect.stringContaining("rejected the token") } });
  });

  it("gives up on a Home Assistant that stops answering its pings", async () => {
    const home = fakeHome({ answersPings: false });
    cleanups.push(home.stop);
    const run = watching([home.url]);
    run.start();
    await until("it to give up", () => run.statuses().some((frame) => frame.params.connected === false), 3000);
    expect(run.statuses().find((frame) => frame.params.connected === false)!.params.error).toContain("stopped answering");
    // The heartbeat itself was reported while it was still believed.
    expect(run.statuses().filter((frame) => frame.params.connected === true).length).toBeGreaterThan(1);
  });

  it("answers pings with heartbeats and stays up", async () => {
    const home = fakeHome();
    cleanups.push(home.stop);
    const run = watching([home.url]);
    run.start();
    await until("three heartbeats", () => run.statuses().length >= 4, 3000);
    expect(run.statuses().every((frame) => frame.params.connected === true)).toBe(true);
    expect(home.opened()).toBe(1);
  });

  it("stops: the connection closes and nothing more is reported", async () => {
    const home = fakeHome();
    cleanups.push(home.stop);
    const run = watching([home.url]);
    run.start();
    await until("the snapshot", () => run.states().length === 1);
    run.watcher.stop();
    await until("the connection to close", () => home.open() === 0);
    const count = run.frames.length;
    await quiet(fast.heartbeatMs * 2);
    expect(run.frames.length).toBe(count);
    // And it does not come back.
    expect(home.opened()).toBe(1);
  });

  it("replaces what it watched when told something new, under the new term", async () => {
    const first = fakeHome();
    const second = fakeHome();
    cleanups.push(first.stop, second.stop);
    const run = watching([first.url]);
    run.start(1);
    await until("the first snapshot", () => run.states().length === 1);
    run.watcher.watch({ term: 2, connections: [{ id: "ha_2", urls: [second.url], token: "reader", entities: ["switch.a"] }] });
    await until("the old connection to close", () => first.open() === 0);
    await until("the new snapshot", () => run.states().some((frame) => frame.params.connection === "ha_2"));
    expect(run.states().find((frame) => frame.params.connection === "ha_2")!.params.term).toBe(2);
    await quiet(fast.heartbeatMs * 2);
    // Nothing from the old term after the new one began.
    const afterwards = run.frames.slice(run.frames.findIndex((frame) => frame.params.term === 2));
    expect(afterwards.every((frame) => frame.params.term === 2)).toBe(true);
  });
});

describe("what it is made of", () => {
  it("applies Home Assistant's compressed events", () => {
    const states = new Map<string, EntityState>();
    expect(applyEvent(states, { a: { "switch.a": { s: "on", a: { icon: "x" }, lc: 1, lu: 2 } } })).toEqual(["switch.a"]);
    expect(states.get("switch.a")).toEqual({ state: "on", attributes: {}, lastChanged: 1, lastUpdated: 2 });
    // The same state again, only later: not a change, so not reported, and what it remembers is still what it last reported.
    expect(applyEvent(states, { c: { "switch.a": { "+": { lu: 3 } } } })).toEqual([]);
    expect(states.get("switch.a")!.lastUpdated).toBe(2);
    expect(applyEvent(states, { c: { "switch.a": { "+": { s: "off", lc: 4, lu: 4 } } } })).toEqual(["switch.a"]);
    expect(applyEvent(states, { r: ["switch.a"] })).toEqual([]);
    expect(states.has("switch.a")).toBe(false);
    expect(applyEvent(states, null)).toEqual([]);
  });

  it("turns an address into the WebSocket API's", () => {
    expect(websocketUrl("http://ha.local:8123/")).toBe("ws://ha.local:8123/api/websocket");
    expect(websocketUrl("https://ha.example")).toBe("wss://ha.example/api/websocket");
    expect(websocketUrl("ftp://ha")).toBeNull();
  });

  it("starts from the address that worked last", () => {
    expect(attemptOrder(3, 0)).toEqual([0, 1, 2]);
    expect(attemptOrder(3, 1)).toEqual([1, 2, 0]);
    expect(attemptOrder(2, 1)).toEqual([1, 0]);
    expect(attemptOrder(0, 0)).toEqual([]);
  });

  it("reads what the platform sends and refuses what it cannot", () => {
    const good = { term: 3, connections: [{ id: "ha_1", urls: ["http://ha.local:8123"], token: "t", entities: ["switch.a"] }] };
    expect(parseWatch(good)).toEqual(good);
    expect(parseWatch({ ...good, term: "3" })).toBeNull();
    expect(parseWatch({ term: 3 })).toBeNull();
    expect(parseWatch({ term: 3, connections: [{ id: "x", urls: [1], token: "t", entities: [] }] })).toBeNull();
    expect(parseWatch(null)).toBeNull();
  });

  it("has the timings the firmware has", () => {
    expect(HA_TIMING).toEqual({ connectMs: 10_000, authMs: 10_000, heartbeatMs: 30_000, firstRetryMs: 2_000, maxRetryMs: 60_000 });
  });
});
