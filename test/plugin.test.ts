import { describe, expect, it } from "bun:test";
import { applyPrismKoishiPlugin, Config, version, type PrismKoishiPluginConfig } from "../src";

type Action = (context: any, ...args: unknown[]) => Promise<string> | string;

function createMockKoishiContext(registered: Map<string, Action>, extra: Record<string, unknown> = {}) {
  return {
    command(name: string) {
      return {
        action(handler: Action) {
          registered.set(name, (context, ...args) => handler({ ...context, session: { platform: "onebot", ...context.session } }, ...args));
          return this;
        },
      };
    },
    ...extra,
  };
}

/** A platform's online bot, recording what it was told to send as a channel target. */
function onlineBot(record: (target: string, content: string) => void) {
  return { bots: [{
    platform: "onebot", isActive: true,
    async sendMessage(id: string, content: string) { record(`onebot:${id}`, content); },
    async sendPrivateMessage(id: string, content: string) { record(`onebot:private:${id}`, content); },
  }] };
}

type Say = { message: unknown[]; to?: string };
type Reply = { status: number; body: unknown; serverMs?: number } | null;

/**
 * A platform on the other end of the bot's connection. `commands` answers a
 * command frame with what to say; `requests` answers a route request.
 */
function fakePlatform(options: { commands?: (frame: any) => Say[] | null; requests?: (frame: any) => Reply } = {}) {
  const opened: Array<{ url: string; headers: Record<string, string> }> = [];
  const frames: any[] = [];
  let listeners: Record<string, Array<(event: any) => void>> = {};
  const emit = (type: string, event: any) => { for (const listener of listeners[type] ?? []) listener(event); };
  const push = (frame: unknown) => emit("message", { data: JSON.stringify(frame) });
  const socket = {
    readyState: 0,
    addEventListener(type: string, listener: (event: any) => void) { (listeners[type] ??= []).push(listener); },
    send(data: string) {
      if (data === "ping") {
        setTimeout(() => emit("message", { data: "pong" }), 0);
        return;
      }
      const frame = JSON.parse(data);
      frames.push(frame);
      if (frame.type === "command") {
        const says = options.commands?.(frame);
        if (says) queueMicrotask(() => says.forEach((said, index) =>
          push({ type: "say", replyTo: frame.id, ...said, ...(index === says.length - 1 ? { done: true } : {}) })));
      } else if (frame.type === "request") {
        const reply = options.requests?.(frame);
        if (reply) queueMicrotask(() => push({ type: "response", id: frame.id, ...reply }));
      }
    },
    close() { socket.readyState = 3; emit("close", {}); },
  };
  const factory = (url: string, headers: Record<string, string>) => {
    opened.push({ url, headers });
    listeners = {};
    socket.readyState = 0;
    queueMicrotask(() => { socket.readyState = 1; emit("open", {}); });
    return socket;
  };
  return {
    factory,
    opened,
    frames,
    commands: () => frames.filter((frame) => frame.type === "command"),
    requests: () => frames.filter((frame) => frame.type === "request"),
    hellos: () => frames.filter((frame) => frame.type === "hello"),
    push,
    drop() { socket.close(); },
    connected: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

const connection = { shopCode: "shop-a", baseUrl: "https://prism.test", integrationToken: "test-token" };
const said = (text: string): Say => ({ message: [{ text }] });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function connectedBot(platformOptions: Parameters<typeof fakePlatform>[0], config: Partial<PrismKoishiPluginConfig> = {}, extra: Record<string, unknown> = {}) {
  const registered = new Map<string, Action>();
  const platform = fakePlatform(platformOptions);
  applyPrismKoishiPlugin(createMockKoishiContext(registered, extra) as any, { ...connection, socket: platform.factory, ...config });
  await platform.connected();
  return { registered, platform, run: (name: string, context: any, ...args: unknown[]) => registered.get(name)!(context, ...args) };
}

describe("forwarding commands to the platform", () => {
  it("configures only how to reach the shop", () => {
    expect(Config).toBeDefined();
  });

  it("registers the platform's commands and its own", async () => {
    const { registered } = await connectedBot({});
    expect([...registered.keys()]).toEqual([
      "bind <code:string>", "prism.bind <code:string>", "login [target:user]", "入场 [target:user]",
      "mahjong <tableId> [target:user]", "上桌 [tableId] [target:user]", "下桌 [tableId] [target:user]", "麻将列表",
      "logout [target:user]", "billing [target:user]", "wallet [target:user]", "items [target:user]",
      "list [name:text]", "show [deviceId]", "history [target:user]", "lock",
      "on <deviceRef>", "off <deviceRef>", "keep <deviceRef>", "coin <deviceRef> [count]", "scan <deviceRef>",
      "redeem <code>", "add <target:user> <amount:number>", "del <target:user> <amount:number>",
      "overwrite <target:user> <amount:number> [reason:text]",
      "api测速 [count:number]", "ws测速 [count:number]", "versions",
    ]);
  });

  it("says hello as a bot that sends commands, over one authenticated connection", async () => {
    const { platform } = await connectedBot({});
    expect(platform.opened).toEqual([{ url: "wss://prism.test/integration/ws", headers: { Authorization: "Bearer test-token" } }]);
    expect(platform.hellos()).toEqual([{ type: "hello", commands: 1 }]);
    // The shop changed the bot's settings: hello again, so the platform rereads them.
    platform.push({ type: "config.changed" });
    expect(platform.hellos()).toHaveLength(2);
  });

  it("sends a command as typed and answers with what the platform says, quoting it", async () => {
    const { platform, run } = await connectedBot({ commands: (frame) => [said(`${frame.name} ${frame.args.join(",")}`)] });
    const session = { userId: "1", channelId: "42", messageId: "m1", bot: { async getUser() { return { name: "群名片" }; } } };
    const answer = await run("coin <deviceRef> [count]", { session }, "mai", 2);
    expect(answer).toBe('<quote id="m1"/>coin mai,2');
    const [frame] = platform.commands();
    expect(frame).toEqual({
      type: "command", id: frame.id, name: "coin", args: ["mai", "2"],
      from: { provider: "onebot", subject: "1", name: "群名片" }, channel: "onebot:42",
    });
  });

  it("sends whom a command is for apart from its arguments, and leaves who may to the platform", async () => {
    const { platform, run } = await connectedBot({ commands: () => [said("ok")] });
    const session = { userId: "1", channelId: "42", bot: { async getUser(id: string) { return { name: `用户${id}` }; } } };
    await run("add <target:user> <amount:number>", { session }, "onebot:2", 5);
    await run("wallet [target:user]", { session });
    const [add, wallet] = platform.commands();
    expect(add).toMatchObject({ name: "add", args: ["5"], target: { provider: "onebot", subject: "2", name: "用户2" } });
    expect(wallet).toMatchObject({ name: "wallet", args: [] });
    expect(wallet.target).toBeUndefined();
  });

  it("names players as this chat knows them", async () => {
    const player = { playerId: "p", displayName: "平台名", identities: [{ provider: "discord", subject: "d" }, { provider: "onebot", subject: "7" }] };
    const { run } = await connectedBot(
      { commands: () => [{ message: [{ text: "玩家：" }, { player }, { image: "x" }, { text: "。" }] }] },
      { resolveDisplayName: (subject, provider) => (provider === "onebot" ? `群名片${subject}` : null) },
    );
    // A segment this version does not know is left out.
    expect(await run("billing [target:user]", { session: { userId: "1", channelId: "42" } })).toBe("玩家：群名片7。");
  });

  it("answers with the first word for here, and sends the rest where the platform says", async () => {
    const delivered: unknown[] = [];
    const { run } = await connectedBot(
      { commands: () => [said("✅ 退场成功"), { to: "private:9", ...said("✅ 退场成功") }, { to: "onebot:43", ...said("另一个群") }] },
      {},
      onlineBot((target, content) => delivered.push(["channel", [target], content])),
    );
    const session = { userId: "1", channelId: "42", bot: { async broadcast(channels: string[], content: string) { delivered.push(["private", channels, content]); } } };
    expect(await run("logout [target:user]", { session })).toBe("✅ 退场成功");
    await tick();
    expect(delivered).toEqual([["private", ["private:9"], "✅ 退场成功"], ["channel", ["onebot:43"], "另一个群"]]);
  });

  it("says a private chat is where a private command came from", async () => {
    const { platform, run } = await connectedBot({ commands: () => [said("ok")] });
    await run("wallet [target:user]", { session: { userId: "1", isDirect: true, channelId: "private:1" } });
    expect(platform.commands()[0].channel).toBe("private:1");
  });

  it("fails a command at once while the connection is down, instead of queueing it", async () => {
    const registered = new Map<string, Action>();
    const sent: string[] = [];
    // A connection that never opens, as while the platform is unreachable.
    const socket = { readyState: 0, addEventListener() {}, send(data: string) { sent.push(data); }, close() {} };
    applyPrismKoishiPlugin(createMockKoishiContext(registered) as any, { ...connection, socket: () => socket });
    expect(await registered.get("wallet [target:user]")!({ session: { userId: "1" } })).toBe("操作失败，暂时连不上服务器。");
    expect(sent).toEqual([]);
  });

  it("says the platform could not be reached when the connection drops before the answer", async () => {
    const { platform, run } = await connectedBot({ commands: () => null });
    const answer = run("wallet [target:user]", { session: { userId: "1" } });
    await tick();
    platform.drop();
    expect(await answer).toBe("操作失败，暂时连不上服务器。");
  });

  it("refuses a sender without a platform identity before asking", async () => {
    const { platform, run } = await connectedBot({ commands: () => [said("ok")] });
    expect(await run("bind <code:string>", { session: { platform: "", userId: "1" } }, "ABCD2345")).toBe("无法获取发送人的平台身份");
    expect(platform.commands()).toEqual([]);
  });
});

describe("the shop's news", () => {
  it("says what the platform says where it says, in order", async () => {
    const broadcasts: unknown[] = [];
    const { platform } = await connectedBot(
      {},
      { resolveDisplayName: (subject) => `Player ${subject}` },
      onlineBot((target, content) => broadcasts.push([[target], content])),
    );
    const alice = { playerId: "p1", displayName: "Alice", identities: [{ provider: "onebot", subject: "7" }] };
    platform.push({ type: "say", to: "onebot:42", message: [{ text: "🎮 " }, { player: alice }, { text: " 在 舞萌 上机" }] });
    platform.push({ type: "say", to: "onebot:42", message: [{ text: "店里没人，1 分钟后全部关机" }] });
    await tick();
    await tick();
    expect(broadcasts).toEqual([[["onebot:42"], "🎮 Player 7 在 舞萌 上机"], [["onebot:42"], "店里没人，1 分钟后全部关机"]]);
  });
});

describe("the bot's own commands", () => {
  it("asks the platform for its version, and keeps its own visible when it cannot", async () => {
    const { run } = await connectedBot({ requests: (frame) => (frame.path === "version" ? { status: 200, body: { version: "1.0.0", revision: "abc123" } } : null) });
    expect(await run("versions", { session: { userId: "1" } })).toBe(`PRiSM 版本信息\nBot：${version}\n后端：1.0.0 (abc123)`);
    const offline = await connectedBot({ requests: () => ({ status: 500, body: {} }) });
    expect(await offline.run("versions", { session: { userId: "1" } })).toBe(`PRiSM 版本信息\nBot：${version}\n后端：不可用`);
  });

  it("times the same wallet query over HTTP and over the connection", async () => {
    const posts: any[] = [];
    const { run, platform } = await connectedBot(
      { requests: (frame) => (frame.path === "integration/players/by-identity/wallet" ? { status: 200, body: { data: { wallet: [] } }, serverMs: 12 } : null) },
      {
        httpPost: async (url, headers, body) => {
          posts.push({ url, headers, body });
          return { status: 200, headers: new Headers({ "x-response-time": "9ms", "cf-ray": "8f00aa-NRT" }), data: { data: { wallet: [] } } };
        },
      },
    );
    const sender = { session: { userId: "42" } };
    const api = await run("api测速 [count:number]", sender, 2);
    expect(api).toContain("首次：");
    expect(api).toContain("服务端处理：平均 9 ms");
    expect(api).toContain("节点：NRT");
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      url: "https://prism.test/api/v1/shops/shop-a/integration/players/by-identity/wallet",
      headers: { authorization: "Bearer test-token" },
      body: { identity: { provider: "onebot", subject: "42" } },
    });
    const ws = await run("ws测速 [count:number]", sender, 3);
    expect(ws).toContain("心跳：最小 ");
    expect(ws).toContain("服务端处理：平均 12 ms");
    expect(platform.requests().filter((frame) => frame.path === "integration/players/by-identity/wallet")).toHaveLength(3);
    expect(await run("ws测速 [count:number]", sender, 11)).toBe("次数须为 1 到 10 的整数。");
  });

  it("learns the shop's code from the platform when it was not configured", async () => {
    const posts: string[] = [];
    const { run } = await connectedBot(
      { requests: (frame) => (frame.path === "integration/bot" ? { status: 200, body: { data: { shop: { code: "from-token" } } } } : null) },
      { shopCode: undefined, httpPost: async (url) => { posts.push(url); return { status: 200, headers: new Headers(), data: {} }; } },
    );
    await run("api测速 [count:number]", { session: { userId: "1" } }, 1);
    expect(posts[0]).toContain("/shops/from-token/");
  });
});

function fakeHomeAssistant() {
  const opened: Array<{ url: string; headers: Record<string, string> }> = [];
  const sockets: Array<{ sent: any[]; closed: boolean; emit(type: string, event: unknown): void }> = [];
  const factory = (url: string, headers: Record<string, string>) => {
    opened.push({ url, headers });
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const socket = {
      readyState: 0,
      sent: [] as any[],
      closed: false,
      addEventListener(type: string, listener: (event: any) => void) { (listeners[type] ??= []).push(listener); },
      send(data: string) { socket.sent.push(JSON.parse(data)); },
      close() { socket.closed = true; socket.readyState = 3; },
      emit(type: string, event: unknown) { for (const listener of listeners[type] ?? []) listener(event); },
    };
    sockets.push(socket);
    queueMicrotask(() => { socket.readyState = 1; socket.emit("open", {}); });
    return socket;
  };
  const say = (index: number, message: unknown) => sockets[index]!.emit("message", { data: JSON.stringify(message) });
  return { factory, opened, sockets, say };
}
const watch = { term: 5, connections: [{ id: "ha_1", urls: ["http://ha.local:8123"], token: "reader", entities: ["switch.a"] }] };

describe("watching Home Assistant for the shop", () => {
  it("says it can, so the platform may ask; the platform decides", async () => {
    const home = fakeHomeAssistant();
    const { platform } = await connectedBot({}, { haSocket: home.factory });
    expect(platform.hellos()).toEqual([{ type: "hello", commands: 1, ha: true }]);
    platform.push({ type: "ha.watch", watch });
    expect(home.opened).toHaveLength(1);
  });

  it("lets the platform take the watch away and hand it back", async () => {
    const home = fakeHomeAssistant();
    const { platform } = await connectedBot({}, { haSocket: home.factory });
    platform.push({ type: "ha.watch", watch });
    expect(home.sockets).toHaveLength(1);
    platform.push({ type: "ha.unwatch" });
    await platform.connected();
    platform.push({ type: "ha.watch", watch });
    expect(home.opened).toHaveLength(2);
  });

  it("subscribes when the platform asks and reports what it sees to the platform", async () => {
    const home = fakeHomeAssistant();
    const { platform } = await connectedBot({}, { haSocket: home.factory });
    platform.push({ type: "ha.watch", watch });
    // Home Assistant is reached by the address given, and signed into with the token given, not the bot's own.
    expect(home.opened).toEqual([{ url: "ws://ha.local:8123/api/websocket", headers: {} }]);
    await platform.connected();
    home.say(0, { type: "auth_required" });
    expect(home.sockets[0]!.sent[0]).toEqual({ type: "auth", access_token: "reader" });
    home.say(0, { type: "auth_ok" });
    expect(home.sockets[0]!.sent[1]).toEqual({ id: 1, type: "subscribe_entities", entity_ids: ["switch.a"] });
    home.say(0, { id: 1, type: "event", event: { a: { "switch.a": { s: "on", a: {}, lc: 10, lu: 10 } } } });
    expect(platform.frames.filter((frame) => frame.type === "ha")).toEqual([
      { type: "ha", method: "ha.status", params: { term: 5, connection: "ha_1", connected: true, error: null } },
      { type: "ha", method: "ha.states", params: { term: 5, connection: "ha_1", full: true, states: [{ entity_id: "switch.a", state: "on", last_changed: 10, last_updated: 10, attributes: {} }] } },
    ]);
  });

  it("lets go of Home Assistant when the platform says so, or an unreadable watch arrives", async () => {
    const home = fakeHomeAssistant();
    const { platform } = await connectedBot({}, { haSocket: home.factory });
    platform.push({ type: "ha.watch", watch });
    await platform.connected();
    platform.push({ type: "ha.unwatch" });
    expect(home.sockets[0]!.closed).toBe(true);
    platform.push({ type: "ha.watch", watch });
    expect(home.sockets).toHaveLength(2);
    // The platform has nothing for it now: a watch it cannot read means stop.
    platform.push({ type: "ha.watch", watch: { term: "x" } });
    expect(home.sockets[1]!.closed).toBe(true);
  });

  it("lets go of Home Assistant when the platform connection drops, as the platform forgets the watch", async () => {
    const home = fakeHomeAssistant();
    const { platform } = await connectedBot({}, { haSocket: home.factory });
    platform.push({ type: "ha.watch", watch });
    await platform.connected();
    platform.drop();
    expect(home.sockets[0]!.closed).toBe(true);
  });
});
