import { describe, expect, it } from "bun:test";
import { applyPrismKoishiPlugin, Config, humanReadableBotError, PrismBotClientError, version, type BotConfig, type PrismKoishiPluginConfig } from "../src";

type RegisteredCommand = {
  description: string;
  action: (sessionContext: any, ...args: string[]) => Promise<string> | string;
};

type BotConfigInput = Partial<Omit<BotConfig, "settings">> & { settings?: Partial<BotConfig["settings"]> };

/** What `GET integration/bot` answers: the platform's defaults, with a test's own changes on top. */
function botConfig(overrides: BotConfigInput = {}): BotConfig {
  return {
    bot: { id: "bot-1", name: "前台 Bot" },
    currencyName: "猫粮",
    billingEnabled: true,
    staff: [],
    door: { id: "door-1", name: "大门" },
    mahjongTables: [],
    ...overrides,
    settings: {
      playerCommands: "all",
      readOnlyNotice: "请扫码操作",
      staffCommands: true,
      powerOffStaffOnly: false,
      receiptsToStaff: false,
      idleChannelIds: [],
      idleReminderMinutes: 5,
      watchHomeAssistant: true,
      ...overrides.settings,
    },
  };
}

const mahjongTable = { id: "table-a", name: "🀄️ 大洋化学", aliases: ["a", "四麻A"], capacity: 4 };

function createMockKoishiContext(registered: Map<string, RegisteredCommand>) {
  return {
    command(name: string, description: string) {
      const command: RegisteredCommand = { description, action: () => "" };
      registered.set(name, command);
      return {
        action(handler: RegisteredCommand["action"]) {
          command.action = (context, ...args) => handler({ ...context, session: { platform: "onebot", ...context.session } }, ...args);
          return this;
        },
      };
    },
    setInterval() {},
  };
}

function createLoggedMockKoishiContext(
  registered: Map<string, RegisteredCommand>,
  warnings: unknown[][],
) {
  return {
    ...createMockKoishiContext(registered),
    logger(name: string) {
      expect(name).toBe("prism");
      return {
        warn(...args: unknown[]) {
          warnings.push(args);
        },
      };
    },
  };
}

function createDefaultClient(bot: BotConfigInput = {}) {
  const calls: any[] = [];
  return {
    calls,
    /** What the bot is told about itself; a test may replace it. */
    bot: botConfig(bot) as BotConfig | PrismBotClientError,
    /** The tables `GET integration/mahjong-tables` reports. */
    tables: [] as any[],
    /** What the mahjong command answers. */
    mahjong: { capacity: 4, seats: [{ playerId: "player-1", name: "Neri", mine: true, playing: false }] } as any,
    async getBotConfig() {
      calls.push(["getBotConfig"]);
      if (this.bot instanceof PrismBotClientError) throw this.bot;
      return this.bot;
    },
    httpTimings: [{ ms: 812.4, serverMs: 31, colo: "HKG" }, { ms: 205.2, serverMs: 29, colo: "HKG" }],
    async timeWalletOverHttp(input: unknown) {
      calls.push(["timeWalletOverHttp", input]);
      return this.httpTimings.shift() ?? { ms: 210, serverMs: 30, colo: "HKG" };
    },
    async timeWalletOverSocket(input: unknown) {
      calls.push(["timeWalletOverSocket", input]);
      return { ms: 198.6, serverMs: 27 };
    },
    async pingSocket() {
      calls.push(["pingSocket"]);
      return 176.2;
    },
    async getVersion() {
      calls.push(["getVersion"]);
      return { service: "prism-api", version: "1.0.0", revision: "backend123" };
    },
    async resolveOrRegisterIdentity(input: unknown) {
      calls.push(["resolveOrRegisterIdentity", input]);
      return { id: "player-1", displayName: "Neri", status: "active" };
    },
    async startSessionByIdentity(input: unknown) {
      calls.push(["startSessionByIdentity", input]);
      return {
        session: {
          id: "session-1",
          playerId: "player-1",
          startedAt: "2026-06-07T10:00:00.000Z",
          status: "active",
        },
        created: true,
      };
    },
    async mahjongByIdentity(input: unknown, table: string, action: string) {
      calls.push(["mahjongByIdentity", input, table, action]);
      return { mahjong: this.mahjong };
    },
    async listMahjongTables() {
      calls.push(["listMahjongTables"]);
      return { tables: this.tables };
    },
    async previewCheckoutByIdentity(input: unknown) {
      calls.push(["previewCheckoutByIdentity", input]);
      return {
        settlementPreview: {
          playerId: "player-1",
          sessionIds: ["session-1"],
          subtotal: 25,
          total: 22,
          status: "preview",
          previewedAt: "2026-06-07T19:00:00.000Z",
        },
        sessionPreviews: [
          {
            sessionId: "session-1",
            label: "音游区间",
            startedAt: "2026-06-07T18:00:00.000Z",
            endedAt: "2026-06-07T19:00:00.000Z",
            status: "closed",
            subtotal: 25,
            total: 22,
            chargeItems: [{ label: "标准计费", amount: 25 }],
            adjustments: [{ label: "月卡折扣", amount: -3 }],
          },
        ],
        chargeItems: [{ label: "标准计费", amount: 25 }],
        adjustments: [{ label: "月卡折扣", amount: -3 }],
        checkoutAdjustments: [{ label: "月卡折扣", amount: -3 }],
        pricingCapAdjustments: [],
        wallet: { balanceBefore: 100, balanceAfter: 78 },
        globalCapWindows: [],
      };
    },
    async confirmCheckoutByIdentity(input: unknown) {
      calls.push(["confirmCheckoutByIdentity", input]);
      return {
        playerSettlement: {
          playerId: "player-1",
          sessionIds: ["session-1"],
          subtotal: 25,
          total: 22,
          status: "settled",
          settledAt: "2026-06-07T19:00:00.000Z",
        },
        settlements: [],
        chargeItems: [],
        adjustments: [],
        checkoutAdjustments: [],
        pricingCapAdjustments: [],
        globalCapWindows: [],
        assetLedgerEntries: [],
        wallet: { balanceBefore: 100, balanceAfter: 78 },
      };
    },
    async getWalletByIdentity(input: unknown) {
      calls.push(["getWalletByIdentity", input]);
      return {
        wallet: [
          { assetCode: "currency.paid", quantity: 60 },
          { assetCode: "currency.free", quantity: 40 },
        ],
      };
    },
    async getAssetsByIdentity(input: unknown) {
      calls.push(["getAssetsByIdentity", input]);
      return { holdings: [{ assetName: "Monthly pass", quantity: 1, expiresAt: null }] };
    },
    async getSessionHistoryByIdentity(input: unknown) {
      calls.push(["getSessionHistoryByIdentity", input]);
      return { sessions: [{ sessionId: "session-1", startedAt: "2026-06-07T18:00:00.000Z", endedAt: "2026-06-07T19:00:00.000Z", total: 25 }] };
    },
    async requestDeviceCommandByIdentity(input: unknown, command: unknown, options?: unknown) {
      calls.push(["requestDeviceCommandByIdentity", input, command, ...(options ? [options] : [])]);
      return {
        action: {
          id: "command-1",
          status: "acked",
          payload: { deviceLabel: "maimai" },
        },
      };
    },
    async requestScanByIdentity(input: unknown, scan: unknown) {
      calls.push(["requestScanByIdentity", input, scan]);
      return { action: { id: "scan-1", status: "acked", payload: { deviceLabel: "舞萌一号" } } };
    },
    async redeemCodeByIdentity(input: unknown, code: string) {
      calls.push(["redeemCodeByIdentity", input, code]);
      return { grantedAssets: [{ assetName: "Coupon", quantity: 1 }] };
    },
    async roster(name?: string) {
      calls.push(["roster", name]);
      return {
        total: 1,
        groups: [{
          kind: "plan", id: "music", name: "音游区间",
          members: [{ playerId: "player-1", displayName: "Player 296", identities: [{ provider: "onebot", subject: "2034994588" }] }],
        }],
      };
    },
    async listDeviceStates() {
      calls.push(["listDeviceStates"]);
      return { deviceStates: [{ deviceId: "ai-1", label: "maimai", state: { state: "on" } }] };
    },
    async adjustWalletByIdentity(identity: unknown, amount: number, reason: string) {
      calls.push(["adjustWalletByIdentity", identity, amount, reason]);
      return { holdings: [], balanceBefore: 100, balanceAfter: 90 };
    },
    async checkoutWithOverrideByIdentity(identity: unknown, total: number, reason: string) {
      calls.push(["checkoutWithOverrideByIdentity", identity, total, reason]);
      return {
        playerSettlement: {
          playerId: "player-1",
          sessionIds: ["session-1"],
          subtotal: total,
          total,
          status: "settled",
          settledAt: "2026-06-07T19:00:00.000Z",
        },
        settlements: [],
        chargeItems: [],
        adjustments: [],
        checkoutAdjustments: [],
        pricingCapAdjustments: [],
        globalCapWindows: [],
        assetLedgerEntries: [],
        wallet: { balanceBefore: 100, balanceAfter: 100 - total },
      };
    },
  };
}

type Reply = { status: number; body: unknown } | null;

/**
 * A scripted PRiSM end of the bot connection. It answers `GET integration/bot`
 * with `settings` (a status and body to refuse it), and everything else with `answer`.
 */
function fakePlatform(answer: (frame: any) => Reply | Promise<Reply>, initial: BotConfigInput = {}) {
  const opened: Array<{ url: string; headers: Record<string, string> }> = [];
  const frames: any[] = [];
  const state = { settings: botConfig(initial) as BotConfig | { status: number; body: unknown } };
  let listeners: Record<string, Array<(event: any) => void>> = {};
  const emit = (type: string, event: any) => { for (const listener of listeners[type] ?? []) listener(event); };
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
      if (frame.type !== "request") return;
      const settings = state.settings;
      const reply = frame.path === "integration/bot"
        ? ("status" in settings ? settings : { status: 200, body: settings })
        : answer(frame);
      Promise.resolve(reply).then((reply) => {
        if (reply) emit("message", { data: JSON.stringify({ type: "response", id: frame.id, ...reply }) });
      });
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
    /** Every request but the bot reading its settings. */
    requests: () => frames.filter((frame) => frame.type === "request" && frame.path !== "integration/bot"),
    /** How often the bot read its settings. */
    settingsReads: () => frames.filter((frame) => frame.type === "request" && frame.path === "integration/bot").length,
    hellos: () => frames.filter((frame) => frame.type === "hello"),
    /** The shop changes the bot's settings and tells it so. */
    change(settings: BotConfigInput) {
      state.settings = botConfig(settings);
      emit("message", { data: JSON.stringify({ type: "config.changed" }) });
    },
    /** The shop disables the bot, or the platform refuses its settings otherwise. */
    refuse(status: number, code: string, message: string) {
      state.settings = { status, body: { error: { code, message } } };
    },
    push(event: string, data: unknown) { emit("message", { data: JSON.stringify({ type: "event", event, data }) }); },
    /** Any frame the platform could send, for what is not an event. */
    pushFrame(frame: unknown) { emit("message", { data: JSON.stringify(frame) }); },
    /** The platform connection drops. */
    drop() { socket.close(); },
    connected: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

const connection = { shopCode: "shop-a", baseUrl: "https://prism.test", integrationToken: "test-token" };

describe("applyPrismKoishiPlugin", () => {
  it("reports an inactive player with the standard failure wording", () => {
    expect(humanReadableBotError(new PrismBotClientError(
      "Player device command requires an active session.",
      "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION",
      400,
      {},
    ))).toBe("操作失败，玩家未入场");
  });

  it("says the server cannot be reached without exposing addresses or raw errors", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const warnings: unknown[][] = [];
    applyPrismKoishiPlugin(createLoggedMockKoishiContext(registered, warnings), {
      ...connection,
      socket: () => { throw new TypeError("connect wss://prism.test/api/v1/shops/shop-a/integration/ws failed"); },
    });
    const result = await registered.get("wallet [target:user]")?.action({ session: { userId: "player-1" } });
    expect(result).toBe("操作失败，暂时连不上服务器。");
    expect(result).not.toContain("wss://");
    expect(warnings.some(([message]) => message === "PRiSM connection failed")).toBe(true);
  });

  it("renders failures in Chinese without exposing English status text", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const platform = fakePlatform(() => ({ status: 404, body: "NOT FOUND" }));
    applyPrismKoishiPlugin(createLoggedMockKoishiContext(registered, []), { ...connection, socket: platform.factory });
    await platform.connected();
    const result = await registered.get("wallet [target:user]")?.action({ session: { userId: "player-1" } });
    expect(result).toBe("操作失败，请稍后再试。");
    expect(result).not.toContain("NOT FOUND");
  });

  it("does not expose unknown backend error messages", () => {
    expect(humanReadableBotError(new PrismBotClientError(
      "Internal route name and implementation details",
      "UNKNOWN_BACKEND_ERROR",
      500,
      {},
    ))).toBe("操作失败，请稍后再试。");
  });

  it("configures only how to reach the shop", () => {
    const keys = Object.keys((Config as any).dict ?? {});
    expect(keys.sort()).toEqual(["baseUrl", "integrationToken", "shopCode"]);
    for (const key of keys) expect((Config as any).dict[key].meta?.required).toBe(true);
    expect(Config({ ...connection })).toEqual(connection);
  });

  it("registers all player commands and basic flows work", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = { client: client as any };

    applyPrismKoishiPlugin(ctx, config);

    const expected = [
      "bind <code:string>",
      "prism.bind <code:string>",
      "login [target:user]",
      "入场 [target:user]",
      "mahjong <tableId>",
      "上桌 [tableId]",
      "下桌 [tableId]",
      "麻将列表",
      "logout [target:user]",
      "billing [target:user]",
      "wallet [target:user]",
      "api测速 [count:number]",
      "ws测速 [count:number]",
      "versions",
      "items [target:user]",
      "list [name:text]",
      "show [deviceId]",
      "history [target:user]",
      "lock",
      "on <deviceRef>",
      "off <deviceRef>",
      "keep <deviceRef>",
      "coin <deviceRef> [count]",
      "scan <deviceRef>",
      "redeem <code>",
      "add <target:user> <amount:number>",
      "del <target:user> <amount:number>",
      "overwrite <target:user> <amount:number> [reason:text]",
    ];
    expect([...registered.keys()]).toEqual(expected);

    await expect(registered.get("login [target:user]")?.action({ session: { userId: "123456", senderName: "Tester" } })).resolves.toContain("✅ 入场成功");
    await expect(registered.get("wallet [target:user]")?.action({ session: { userId: "123456" } })).resolves.toContain("100 猫粮");

    const billingResult = await registered.get("billing [target:user]")?.action({
      session: {
        userId: "123456",
        senderName: "Tester",
        bot: {
          async getUser(id: string) {
            return id === "123456" ? { name: "Tester" } : { name: "" };
          },
        },
      },
    });
    expect(billingResult).toContain("玩家：Tester（onebot:123456）");
    expect(billingResult).toContain("⏰ 游玩时间：");
    expect(billingResult).toContain("音游区间");
    expect(billingResult).toContain("游玩时长：1小时0分钟｜计价：22猫粮");
    expect(billingResult).toContain("  └ 月卡折扣：-3猫粮");
    expect(billingResult).toContain("计费总价：25猫粮");
    expect(billingResult).toContain("优惠后价格：22猫粮");
    expect(billingResult).toContain("当前余额：100猫粮");
    expect(billingResult).toContain("预计结账后余额：78猫粮");
    expect(billingResult).not.toContain("玩家ID：");
    expect(billingResult).not.toContain("————————————");
    expect(billingResult).not.toContain("　｜　");

    const listResult = await registered.get("list [name:text]")?.action({ session: { userId: "123456" } });
    expect(listResult).toContain("[总计 1 人]");
    expect(listResult).toContain("Player 296");

    const benchmark = await registered.get("api测速 [count:number]")?.action({ session: { userId: "123456" } }, "2");
    expect(benchmark).toBe("📡 API 测速（HTTP，钱包查询 2 次）\n首次：812 ms（含建立连接）\n之后：最小 205 / 平均 205 / 最大 205 ms\n服务端处理：平均 30 ms\n节点：HKG");
    const wsBenchmark = await registered.get("ws测速 [count:number]")?.action({ session: { userId: "123456" } }, "2");
    expect(wsBenchmark).toBe("📡 WS 测速（2 次）\n心跳：最小 176 / 平均 176 / 最大 176 ms\n钱包查询：最小 199 / 平均 199 / 最大 199 ms\n服务端处理：平均 27 ms");
    await expect(registered.get("ws测速 [count:number]")!.action({ session: { userId: "123456" } }, "11")).resolves.toBe("次数须为 1 到 10 的整数。");

    await expect(registered.get("versions")?.action({ session: { userId: "123456" } })).resolves.toBe(
      `PRiSM 版本信息\nBot：${version}\n后端：1.0.0 (backend123)`,
    );
  });

  it("keeps the Bot version visible when backend version lookup fails", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.getVersion = async () => {
      throw new Error("offline");
    };
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    await expect(registered.get("versions")?.action({ session: { userId: "123456" } })).resolves.toBe(
      `PRiSM 版本信息\nBot：${version}\n后端：不可用`,
    );
  });

  it("asks the platform for its version over the connection", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const platform = fakePlatform((frame) => frame.path === "version"
      ? { status: 200, body: { service: "prism-api", version: "1.0.0", revision: "abc123" } }
      : null);
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { ...connection, socket: platform.factory });
    await platform.connected();
    await expect(registered.get("versions")?.action({ session: { userId: "123456" } })).resolves.toContain("后端：1.0.0 (abc123)");
  });

  it("quotes command replies and sends receipts to staff on the same platform", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({
      settings: { receiptsToStaff: true },
      staff: [
        { provider: "onebot", subject: "staff-1" },
        { provider: "onebot", subject: "audit-1" },
        { provider: "telegram", subject: "staff-1" },
      ],
    });
    const broadcasts: Array<[string[], string]> = [];
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const bot = {
      async broadcast(userIds: string[], content: string) {
        broadcasts.push([userIds, content]);
      },
    };

    const loginResult = await registered.get("login [target:user]")?.action({
      session: { userId: "123456", senderName: "Tester", messageId: "message-1", bot },
    });
    expect(loginResult).toContain("quote");
    expect(loginResult).toContain("✅ 入场成功");

    const logoutResult = await registered.get("logout [target:user]")?.action({
      session: { userId: "123456", senderName: "Tester", messageId: "message-2", bot },
    });
    expect(logoutResult).toContain("quote");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0][0]).toEqual(["private:staff-1", "private:audit-1"]);
    expect(broadcasts[0][1]).toContain("✅ 退场成功 · 结算账单");
    expect(broadcasts[0][1]).toContain("玩家：Tester（onebot:123456）");
    expect(broadcasts[0][1]).not.toContain("quote");
  });

  it("sends staff the receipt when overwrite command is executed", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({
      settings: { receiptsToStaff: true },
      staff: [{ provider: "onebot", subject: "staff-1" }, { provider: "onebot", subject: "audit-1" }],
    });
    const broadcasts: Array<[string[], string]> = [];
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const bot = {
      async broadcast(userIds: string[], content: string) {
        broadcasts.push([userIds, content]);
      },
    };

    client.checkoutWithOverrideByIdentity = async () => {
      return {
        playerSettlement: { playerId: "player-1", subtotal: 10, total: 30, status: "settled", settledAt: new Date() },
        settlements: [],
        chargeItems: [],
        adjustments: [],
        checkoutAdjustments: [],
        pricingCapAdjustments: [],
        globalCapWindows: [],
        assetLedgerEntries: [],
        wallet: { balanceBefore: 100, balanceAfter: 70 },
      };
    };

    const overwriteResult = await registered.get("overwrite <target:user> <amount:number> [reason:text]")?.action({
      session: { userId: "staff-1", senderName: "Admin", messageId: "message-3", bot },
    }, "target-qq", "30");

    expect(overwriteResult).toContain("quote");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0][0]).toEqual(["private:staff-1", "private:audit-1"]);
    expect(broadcasts[0][1]).toContain("✅ 覆盖结账成功 · 结算账单");
    expect(broadcasts[0][1]).not.toContain("quote");
  });

  it("coalesces concurrent logout commands for the same player", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    let confirmations = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    client.confirmCheckoutByIdentity = async () => {
      confirmations++;
      await pending;
      return {
        playerSettlement: { playerId: "player-1", subtotal: 10, total: 10 },
        settlements: [],
        chargeItems: [],
        adjustments: [],
        checkoutAdjustments: [],
        pricingCapAdjustments: [],
        globalCapWindows: [],
        assetLedgerEntries: [],
        wallet: { balanceBefore: 100, balanceAfter: 90 },
      };
    };
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const logout = registered.get("logout [target:user]")!.action;
    const first = logout({ session: { userId: "123456", senderName: "Tester" } });
    const second = logout({ session: { userId: "123456", senderName: "Tester" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmations).toBe(1);
    release();
    expect(await first).toBe(await second);
  });

  it("never coalesces settlements from two adapters sharing a userId", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    const seen: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    client.confirmCheckoutByIdentity = async (input: any) => {
      seen.push(`${input.provider}:${input.subject}`);
      await pending;
      return {
        playerSettlement: { playerId: `player-${input.provider}`, subtotal: 10, total: 10 },
        settlements: [], chargeItems: [], adjustments: [],
        checkoutAdjustments: [], pricingCapAdjustments: [],
        globalCapWindows: [], assetLedgerEntries: [],
        wallet: { balanceBefore: 100, balanceAfter: 90 },
      };
    };
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const logout = registered.get("logout [target:user]")!.action;
    const onebot = logout({ session: { platform: "onebot", userId: "10086" } });
    const telegram = logout({ session: { platform: "telegram", userId: "10086" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.sort()).toEqual(["onebot:10086", "telegram:10086"]);
    release();
    expect(await onebot).toContain("退场成功");
    expect(await telegram).toContain("退场成功");
  });

  it("registers administrator shortcuts with target authorization and staff writes", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient({ staff: [{ provider: "onebot", subject: "admin" }] });
    const config: PrismKoishiPluginConfig = { client: client as any };
    const adminContext = { session: { userId: "admin", senderName: "Admin" } };
    const playerContext = { session: { userId: "player", senderName: "Player" } };

    applyPrismKoishiPlugin(ctx, config);

    expect([...registered.keys()]).toEqual(expect.arrayContaining([
      "login [target:user]",
      "入场 [target:user]",
      "logout [target:user]",
      "billing [target:user]",
      "wallet [target:user]",
      "items [target:user]",
      "history [target:user]",
      "add <target:user> <amount:number>",
      "del <target:user> <amount:number>",
      "overwrite <target:user> <amount:number> [reason:text]",
    ]));
    await expect(registered.get("login [target:user]")?.action(adminContext, "target-qq")).resolves.toContain("已为用户");
    await expect(registered.get("login [target:user]")?.action(adminContext, "onebot:262661418")).resolves.toContain("已为用户 未知昵称（onebot:262661418） 入场");
    await expect(registered.get("login [target:user]")?.action(playerContext, "target-qq")).resolves.toBe("权限不足");
    await expect(registered.get("add <target:user> <amount:number>")?.action(adminContext, "target-qq", "10")).resolves.toContain("已为用户");
    await expect(registered.get("del <target:user> <amount:number>")?.action(adminContext, "target-qq", "3")).resolves.toContain("已为用户");
    await expect(registered.get("overwrite <target:user> <amount:number> [reason:text]")?.action(adminContext, "target-qq", "30")).resolves.toContain("覆盖结账成功");

    expect(client.calls).toContainEqual(["adjustWalletByIdentity", {
      provider: "onebot", subject: "target-qq", displayName: "target-qq",
    }, 10, "Koishi 管理员增加余额"]);
    expect(client.calls).toContainEqual(["adjustWalletByIdentity", {
      provider: "onebot", subject: "target-qq", displayName: "target-qq",
    }, -3, "Koishi 管理员扣除余额"]);
    expect(client.calls).toContainEqual(["checkoutWithOverrideByIdentity", {
      provider: "onebot", subject: "target-qq", displayName: "target-qq",
    }, 30, "管理员调价"]);
    expect(client.calls).toContainEqual(["startSessionByIdentity", {
      provider: "onebot", subject: "262661418", displayName: "262661418",
    }]);
  });

  it("denies targeted administrator shortcuts when the shop has no staff identities", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient({ staff: [] });

    applyPrismKoishiPlugin(ctx, { client: client as any });

    await expect(
      registered.get("login [target:user]")?.action({ session: { userId: "unlisted-admin" } }, "target-qq"),
    ).resolves.toBe("权限不足");
  });

  it("uses platform display name when resolver is provided", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      resolveDisplayName: () => Promise.resolve("🎀hanahana🎀"),
      client: client as any,
    };
    applyPrismKoishiPlugin(ctx, config);
    const listResult = await registered.get("list [name:text]")?.action({ session: { userId: "123456" } });
    expect(listResult).toContain("🎀hanahana🎀");
  });

  it("prints the platform's roster: each person once, resources with their head count and capacity", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ mahjongTables: [mahjongTable] });
    const member = (n: number, name?: string) => ({ playerId: `player-${n}`, displayName: name ?? `后台 ${n}`, identities: [{ provider: "onebot", subject: String(n) }] });
    client.roster = async () => ({
      total: 6,
      groups: [
        { kind: "plan", id: "music", name: "音乐游戏", members: [member(1), member(2)] },
        { kind: "resource", id: "cab", name: "maimai", capacity: 2, members: [member(5)] },
        { kind: "resource", id: "table-a", name: "🀄️ 大洋化学", capacity: 4, members: [member(3), member(4), member(6, "等位玩家")] },
      ],
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), {
      resolveDisplayName: (subject) => (subject === "6" ? null : `Player ${subject}`),
      client: client as any,
    });

    const result = await registered.get("list [name:text]")?.action({ session: { userId: "1" } });
    expect(result).toBe([
      "[总计 6 人]",
      "\n音乐游戏 ( 2人 )：\n- Player 1, - Player 2",
      "\nmaimai ( 1/2 )：\n- Player 5",
      "\n🀄️ 大洋化学 ( 3/4 )：\n- Player 3, - Player 4, - 等位玩家",
    ].join("\n"));
  });

  it("lists one resource or one plan by name, and says when nothing has that name", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.roster = async (name?: string) => {
      if (name === "大厅") throw new PrismBotClientError("找不到「大厅」", "ROSTER_TARGET_NOT_FOUND", 404, null);
      return name === "maimai"
        ? { total: 0, groups: [{ kind: "resource", id: "cab", name: "maimai", capacity: 2, members: [] }] }
        : { total: 1, groups: [{ kind: "plan", id: "base", name: "基础", members: [{ playerId: "a", displayName: "A", identities: [] }] }] };
    };
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const list = registered.get("list [name:text]")!;
    await expect(list.action({ session: { userId: "1" } }, "基础")).resolves.toBe("[总计 1 人]\n\n基础 ( 1人 )：\n- A");
    await expect(list.action({ session: { userId: "1" } }, "maimai")).resolves.toBe("maimai ( 0/2 )");
    await expect(list.action({ session: { userId: "1" } }, "大厅")).resolves.toBe("找不到「大厅」");
  });

  it("asks for no tables when the shop has none", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    await registered.get("list [name:text]")?.action({ session: { userId: "1" } });
    expect(client.calls.some((call) => call[0] === "listMahjongTables")).toBe(false);
    expect(client.calls.some((call) => call[0] === "roster")).toBe(true);
    await expect(registered.get("麻将列表")!.action({ session: { userId: "1" } })).resolves.toBe("当前没有配置任何麻将机。");
  });

  it("shows device states and power commands", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = { client: client as any };
    applyPrismKoishiPlugin(ctx, config);
    const list = await registered.get("show [deviceId]")?.action({ session: { userId: "123456" } });
    expect(list).toContain("maimai: on");
    const res = await registered.get("show [deviceId]")?.action({ session: { userId: "123456" } }, "ai-1");
    expect(res).toContain("maimai: on");
    const onResult = await registered.get("on <deviceRef>")?.action({ session: { userId: "123456" } }, "ai-1");
    expect(onResult).toContain("maimai 启动成功");
    expect(client.calls).toContainEqual([
      "requestDeviceCommandByIdentity",
      expect.anything(),
      {
        type: "power.on",
        target: { kind: "facility", ref: "ai-1" },
        payload: { state: "on" },
      },
    ]);
    const coinResult = await registered.get("coin <deviceRef> [count]")?.action({ session: { userId: "123456" } }, "ai-1", "2");
    expect(coinResult).toContain("maimai 投币成功（2 币）");
    const scanResult = await registered.get("scan <deviceRef>")?.action({ session: { userId: "123456" } }, "aime-1");
    expect(scanResult).toContain("舞萌一号 刷卡成功");
    expect(client.calls).toContainEqual([
      "requestScanByIdentity",
      expect.anything(),
      { deviceRef: "aime-1", provider: "aime" },
    ]);
    const redeemResult = await registered.get("redeem <code>")?.action({ session: { userId: "123456" } }, "PRISM-2026");
    expect(redeemResult).toContain("兑换成功");
  });

  it("returns the generated TTLock temporary password from lock", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.requestDeviceCommandByIdentity = async () => ({
      action: {
        executorKind: "ttlock",
        status: "acked",
        payload: { temporaryPassword: "12345678" },
      },
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    await expect(registered.get("lock")?.action({ session: { userId: "123456" } })).resolves.toBe(
      "🔑 临时门锁密码：12345678\n有效期：3 分钟",
    );
  });

  it("opens the door the bot's settings name, and says so when there is none", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ door: { id: "door-7", name: "侧门" } });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    await registered.get("lock")?.action({ session: { userId: "123456" } });
    expect(client.calls).toContainEqual(["requestDeviceCommandByIdentity", expect.anything(), {
      type: "door.open",
      target: { kind: "facility", ref: "door-7" },
    }]);

    client.bot = botConfig({ door: null });
    const doorless = new Map<string, RegisteredCommand>();
    applyPrismKoishiPlugin(createMockKoishiContext(doorless), { client: client as any });
    client.calls.length = 0;
    await expect(doorless.get("lock")!.action({ session: { userId: "123456" } })).resolves.toBe("🔑 本店还没有设置 Bot 开的门");
    expect(client.calls.some((call) => call[0] === "requestDeviceCommandByIdentity")).toBe(false);
  });

  it("does not report a password when TTLock generation fails", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.requestDeviceCommandByIdentity = async () => ({
      action: {
        executorKind: "ttlock",
        status: "expired",
        payload: {
          executorFailure: {
            executorKind: "ttlock",
            message: "TTLock 请求失败（10004）",
          },
        },
      },
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    const result = await registered.get("lock")?.action({ session: { userId: "123456" } });
    expect(result).toBe("🔑 开门失败，请稍后再试");
    expect(result).not.toMatch(/\d{8}/);
  });

  it("shows plain, legacy JSON, and object device state formats", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.listDeviceStates = async () => ({
      deviceStates: [
        { deviceId: "plain", label: "普通格式", state: "on" },
        { deviceId: "legacy", label: "历史格式", state: JSON.stringify({ state: "off" }) },
        { deviceId: "object", label: "旧对象格式", state: { state: "on" } },
      ],
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    const result = await registered.get("show [deviceId]")?.action({
      session: { userId: "player-1" },
    });

    expect(result).toBe("普通格式: on\n历史格式: off\n旧对象格式: on");
  });

  it("keeps remote device failures concise and does not expose backend details", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const warnings: unknown[][] = [];
    const client = createDefaultClient();
    applyPrismKoishiPlugin(createLoggedMockKoishiContext(registered, warnings), { client: client as any });

    client.requestDeviceCommandByIdentity = async () => {
      throw new PrismBotClientError("Machine ref was not found.", "DEVICE_NOT_FOUND", 400, {});
    };
    await expect(registered.get("coin <deviceRef> [count]")?.action(
      { session: { userId: "player-1" } },
      "不存在",
      "1",
    )).resolves.toBe("投币失败，设备不存在");

    client.requestScanByIdentity = async () => {
      throw new PrismBotClientError(
        "No Aime identity for player.",
        "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER",
        400,
        {},
      );
    };
    await expect(registered.get("scan <deviceRef>")?.action(
      { session: { userId: "player-1" } },
      "舞萌左机",
    )).resolves.toBe("刷卡失败，玩家未绑定 Aime 卡");

    client.requestDeviceCommandByIdentity = async () => ({
      action: {
        status: "expired",
        payload: {
          executorFailure: {
            message: "Hinata IO request to https://private.example failed",
          },
        },
      },
    });
    const failed = await registered.get("coin <deviceRef> [count]")?.action(
      { session: { userId: "player-1" } },
      "舞萌左机",
      "1",
    );
    expect(failed).toBe("投币失败，请稍后再试");
    expect(failed).not.toContain("private.example");
    expect(warnings).toHaveLength(3);
    expect(warnings[2]).toContainEqual({
      message: "Hinata IO request to https://private.example failed",
    });
  });

  it("handles command execution failure feedback from server", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const warnings: unknown[][] = [];
    const ctx = createLoggedMockKoishiContext(registered, warnings);
    const client = createDefaultClient();
    applyPrismKoishiPlugin(ctx, { client: client as any });

    // Mock execution error from server
    client.requestDeviceCommandByIdentity = async () => ({
      action: {
        id: "command-fail",
        status: "expired",
        payload: {
          executorFailure: {
            message: "设备不存在",
          },
        },
      },
    });

    const failedResult = await registered.get("on <deviceRef>")?.action({ session: { userId: "123" } }, "ai-1");
    expect(failedResult).toBe("启动失败，请稍后再试");
    expect(warnings).toContainEqual([
      "PRiSM device command failed",
      { message: "设备不存在" },
    ]);
  });

  it("requires players to be active for both power commands", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.requestDeviceCommandByIdentity = async () => {
      throw new PrismBotClientError(
        "Player device command requires an active session.",
        "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION",
        400,
        {},
      );
    };
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    const context = { session: { userId: "player-1" } };
    await expect(registered.get("on <deviceRef>")?.action(context, "maimai")).resolves.toBe(
      "启动失败，玩家未入场",
    );
    await expect(registered.get("off <deviceRef>")?.action(context, "maimai")).resolves.toBe(
      "关闭失败，玩家未入场",
    );
  });

  it("logs the original power-command error while keeping the reply generic", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const warnings: unknown[][] = [];
    const client = createDefaultClient();
    const originalError = new TypeError("fetch https://private.example/device-actions failed");
    client.requestDeviceCommandByIdentity = async () => {
      throw new PrismBotClientError(
        "Unable to reach backend.",
        "API_UNREACHABLE",
        0,
        {},
        originalError,
      );
    };
    applyPrismKoishiPlugin(createLoggedMockKoishiContext(registered, warnings), { client: client as any });

    const result = await registered.get("on <deviceRef>")?.action(
      { session: { userId: "player-1" } },
      "maimai",
    );

    expect(result).toBe("启动失败，请稍后再试");
    expect(result).not.toContain("private.example");
    expect(warnings).toEqual([["PRiSM Bot command failed", originalError]]);
  });

  it("supports staff-only power off", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ settings: { powerOffStaffOnly: true }, staff: [{ provider: "onebot", subject: "admin-1" }] });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    // A player may still switch on, but not off.
    await expect(registered.get("on <deviceRef>")?.action({ session: { userId: "player-1" } }, "maimai")).resolves.toContain("启动成功");
    await expect(registered.get("off <deviceRef>")?.action({ session: { userId: "player-1" } }, "maimai")).resolves.toBe("关闭失败，权限不足");

    await expect(registered.get("on <deviceRef>")?.action(
      { session: { userId: "admin-1" } },
      "maimai",
    )).resolves.toContain("启动成功");
    expect(client.calls).toContainEqual([
      "requestDeviceCommandByIdentity",
      expect.objectContaining({ subject: "admin-1" }),
      expect.objectContaining({ type: "power.on" }),
    ]);
    await expect(registered.get("off <deviceRef>")?.action(
      { session: { userId: "admin-1" } },
      "maimai",
    )).resolves.toContain("关闭成功");
    expect(client.calls).toContainEqual([
      "requestDeviceCommandByIdentity",
      expect.objectContaining({ subject: "admin-1" }),
      expect.objectContaining({ type: "power.off" }),
      { staffOverride: true },
    ]);
  });

  it("uses the backend device label for power replies without special-casing all", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.requestDeviceCommandByIdentity = async () => ({
      action: {
        status: "acked",
        payload: { deviceLabel: "所有设备" },
      },
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    const onResult = await registered.get("on <deviceRef>")?.action({ session: { userId: "123" } }, "all");
    const offResult = await registered.get("off <deviceRef>")?.action({ session: { userId: "123" } }, "all");

    expect(onResult).toBe("✅ 所有设备 启动成功");
    expect(offResult).toBe("🛑 所有设备 关闭成功");
  });

  it("seats a player at a table the bot's settings name, by name or alias", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ mahjongTables: [mahjongTable] });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const hanahana = { session: { userId: "2034994588", senderName: "hanahana" } };

    await expect(registered.get("上桌 [tableId]")!.action(hanahana, "不存在")).resolves.toContain("未找到麻将桌「不存在」");
    await expect(registered.get("上桌 [tableId]")!.action(hanahana)).resolves.toContain("请指定麻将桌");
    expect(client.calls.some((call) => call[0] === "mahjongByIdentity")).toBe(false);

    // A player need not enter first: the platform starts billing when the table fills.
    await expect(registered.get("上桌 [tableId]")!.action(hanahana, "四麻a")).resolves.toBe(
      "已加入 🀄️ 大洋化学，当前 1/4 人，满 4 人开始计费。",
    );
    expect(client.calls).toContainEqual(["mahjongByIdentity", { provider: "onebot", subject: "2034994588", displayName: "hanahana" }, "table-a", "join"]);

    client.mahjong = {
      capacity: 4,
      seats: ["1", "2", "3", "4"].map((id) => ({ playerId: `player-${id}`, name: id, mine: id === "4", playing: true })),
    };
    await expect(registered.get("mahjong <tableId>")!.action(hanahana, "🀄️ 大洋化学")).resolves.toBe(
      "已加入 🀄️ 大洋化学，麻将计费已开始。当前 4/4 人。",
    );
  });

  it("relays why the platform would not seat a player", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ mahjongTables: [mahjongTable] });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const join = (code: string, message: string, status = 409) => {
      client.mahjongByIdentity = async () => { throw new PrismBotClientError(message, code, status, { error: { code, message } }); };
      return registered.get("上桌 [tableId]")!.action({ session: { userId: "1" } }, "a");
    };
    await expect(join("MAHJONG_TABLE_FULL", "已满桌")).resolves.toBe("「🀄️ 大洋化学」已满桌，请等待本局结束后再上桌。");
    await expect(join("MAHJONG_ALREADY_SEATED", "请先从当前麻将桌下桌")).resolves.toBe("你已经在另一张麻将桌上，请先 /下桌。");
    await expect(join("MAHJONG_TABLE_NOT_FOUND", "没有找到这张麻将桌", 404)).resolves.toContain("未找到麻将桌「a」");
    await expect(join("PLAYER_SESSION_OUTSIDE_BILLABLE_TIME", "当前不在麻将计费时段")).resolves.toBe("上桌失败，当前不在麻将计费时段");
    // A server fault is not relayed.
    await expect(join("INTERNAL_ERROR", "stack trace", 500)).resolves.toBe("操作失败，请稍后再试。");
  });

  it("finds the table a player sits at to leave it", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ mahjongTables: [mahjongTable, { id: "table-b", name: "B 桌", aliases: ["b"], capacity: 4 }] });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const player = { session: { userId: "1" } };

    await expect(registered.get("下桌 [tableId]")!.action(player)).resolves.toBe("你当前未在任何麻将桌上。");
    expect(client.calls.some((call) => call[0] === "mahjongByIdentity")).toBe(false);

    client.tables = [
      { id: "table-b", name: "B 桌", aliases: ["b"], capacity: 4, seats: [{ playerId: "player-9", name: "9", playing: false }] },
      { ...mahjongTable, seats: [
        { playerId: "player-1", name: "Neri", playing: true },
        { playerId: "player-2", name: "2", playing: true },
      ] },
    ];
    client.mahjong = { capacity: 4, seats: [{ playerId: "player-2", name: "2", mine: false, playing: true }] };
    await expect(registered.get("下桌 [tableId]")!.action(player, "b")).resolves.toBe("你当前不在 B 桌。");
    await expect(registered.get("下桌 [tableId]")!.action(player)).resolves.toBe("已离开 🀄️ 大洋化学，麻将计费已停止。当前还剩 1/4 人。");
    expect(client.calls).toContainEqual(["mahjongByIdentity", expect.objectContaining({ subject: "1" }), "table-a", "leave"]);

    // Getting up does not check out; the platform says what still bills.
    client.mahjongByIdentity = async () => ({ mahjong: client.mahjong, billing: { remaining: ["普通游玩"] } });
    await expect(registered.get("下桌 [tableId]")!.action(player)).resolves.toBe(
      "已离开 🀄️ 大洋化学，麻将计费已停止。当前还剩 1/4 人。\n仍在计费：普通游玩",
    );
  });

  it("does not register legacy admin commands", () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    applyPrismKoishiPlugin(ctx, { client: client as any });
    expect([...registered.keys()].some((name) => name.startsWith("admin."))).toBe(false);
  });

  it("denies acting for others when the bot's settings turn staff commands off", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ settings: { staffCommands: false }, staff: [{ provider: "onebot", subject: "admin" }] });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const admin = { session: { userId: "admin" } };
    await expect(registered.get("login [target:user]")!.action(admin, "target-qq")).resolves.toBe("员工命令未启用");
    await expect(registered.get("add <target:user> <amount:number>")!.action(admin, "target-qq", "10")).resolves.toBe("员工命令未启用");
    // Their own commands are not staff commands.
    await expect(registered.get("login [target:user]")!.action(admin)).resolves.toBe("✅ 入场成功");
    expect(client.calls.some((call) => call[0] === "adjustWalletByIdentity")).toBe(false);
  });

  it("fetches platform nickname via bot.getUser during login", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = { client: client as any };
    applyPrismKoishiPlugin(ctx, config);

    let getUserCalled = false;
    const session = {
      userId: "qq-user-123",
      bot: {
        async getUser(id: string) {
          if (id === "qq-user-123") {
            getUserCalled = true;
            return { name: "Dynamic QQ Nickname" };
          }
          return { name: "" };
        },
      },
    };

    await registered.get("login [target:user]")?.action({ session });

    expect(getUserCalled).toBe(true);
    // Verify that the resolved nickname was passed in startSessionByIdentity call
    const startSessionCall = client.calls.find((c) => c[0] === "startSessionByIdentity");
    expect(startSessionCall).toBeDefined();
    expect(startSessionCall[1]).toEqual({
      provider: "onebot",
      subject: "qq-user-123",
      displayName: "Dynamic QQ Nickname",
    });
  });

  it("tells a player already billing that they are in, instead of admitting them again", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ staff: [{ provider: "onebot", subject: "admin" }] });
    client.startSessionByIdentity = async (input: unknown) => {
      client.calls.push(["startSessionByIdentity", input]);
      return { session: { id: "session-1", playerId: "player-1" }, created: false, planName: "普通游玩" };
    };
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    await expect(registered.get("login [target:user]")!.action({ session: { userId: "123456", senderName: "Tester" } })).resolves.toBe("您已在「普通游玩」中，无需重复入场");
    await expect(registered.get("入场 [target:user]")!.action({ session: { userId: "admin" } }, "onebot:42")).resolves.toBe("用户 未知昵称（onebot:42） 已在「普通游玩」中，无需重复入场");
  });

  it("names the plans a start ended", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.startSessionByIdentity = async () => ({
      session: { id: "session-2", playerId: "player-1" }, created: true, planName: "普通游玩",
      billing: { changed: true, created: true, started: ["普通游玩"], stopped: ["夜场"], kept: [] },
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    await expect(registered.get("login [target:user]")!.action({ session: { userId: "123456" } })).resolves.toBe("✅ 入场成功\n结束方案：夜场");
  });

  it("renders a concise zero-cost checkout receipt", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    client.confirmCheckoutByIdentity = async () => ({
      playerSettlement: { playerId: "player-1", subtotal: 0, total: 0 },
      settlements: [{
        settlement: {
          sessionId: "s-1",
          label: "音游区间",
          startedAt: "2026-06-07T18:00:00.000Z",
          endedAt: "2026-06-07T19:00:00.000Z",
          settledAt: "2026-06-07T19:00:00.000Z",
          subtotal: 0,
          total: 0,
        },
        chargeItems: [],
        adjustments: [],
      }],
      chargeItems: [],
      adjustments: [],
      checkoutAdjustments: [],
      pricingCapAdjustments: [],
      globalCapWindows: [],
      assetLedgerEntries: [],
      wallet: { balanceBefore: 9791, balanceAfter: 9791 },
    });
    const config: PrismKoishiPluginConfig = { client: client as any };
    applyPrismKoishiPlugin(ctx, config);

    const result = await registered.get("logout [target:user]")?.action({
      session: { userId: "123456", senderName: "Tester" },
    });
    expect(result).toContain("✅ 退场成功 · 结算账单");
    expect(result).toContain("本次未产生费用");
    expect(result).toContain("余额：9791猫粮");
    expect(result).not.toContain("音游区间");
    expect(result).not.toContain("游玩时间");
    expect(result).not.toContain("游玩时段");
    expect(result).not.toContain("游玩时长");
    expect(result).not.toContain("计费总价：");
    expect(result).not.toContain("扣款后余额：");
  });

  it("renders the confirmed checkout wallet balance", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.confirmCheckoutByIdentity = async () => ({
      playerSettlement: { playerId: "player-1", subtotal: 90, total: 79 },
      settlements: [{
        settlement: {
          sessionId: "s-1",
          label: "🎵 音乐游戏",
          startedAt: "2026-07-10T17:55:00.000Z",
          endedAt: "2026-07-10T23:31:00.000Z",
          settledAt: "2026-07-10T23:31:00.000Z",
          subtotal: 90,
          total: 79,
        },
        chargeItems: [],
        adjustments: [{ label: "夜间", amount: -11 }],
      }],
      chargeItems: [],
      adjustments: [{ label: "夜间", amount: -11 }],
      checkoutAdjustments: [],
      pricingCapAdjustments: [],
      globalCapWindows: [],
      assetLedgerEntries: [],
      wallet: { balanceBefore: 81, balanceAfter: 2 },
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    const result = await registered.get("logout [target:user]")?.action({
      session: { userId: "3202659259", senderName: "李育群" },
    });

    expect(result).toContain("✅ 退场成功 · 结算账单");
    expect(result).toContain("计费总价：90猫粮");
    expect(result).toContain("优惠后价格：79猫粮");
    expect(result).toContain("扣款后余额：2猫粮");
    expect(result).not.toContain("当前余额：");
    expect(result).not.toContain("预计结账后余额：");
  });

  it("shows a zero confirmed wallet balance after a paid checkout", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.confirmCheckoutByIdentity = async () => ({
      playerSettlement: { playerId: "player-1", subtotal: 10, total: 10 },
      settlements: [{
        settlement: {
          sessionId: "s-1",
          label: "🎵 音乐游戏",
          startedAt: "2026-07-10T10:00:00.000Z",
          endedAt: "2026-07-10T11:00:00.000Z",
          settledAt: "2026-07-10T11:00:00.000Z",
          subtotal: 10,
          total: 10,
        },
        chargeItems: [{ label: "标准计费", amount: 10 }],
        adjustments: [],
      }],
      chargeItems: [],
      adjustments: [],
      checkoutAdjustments: [],
      pricingCapAdjustments: [],
      globalCapWindows: [],
      assetLedgerEntries: [],
      wallet: { balanceBefore: 10, balanceAfter: 0 },
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    const result = await registered.get("logout [target:user]")?.action({
      session: { userId: "123456", senderName: "Tester" },
    });

    expect(result).toContain("扣款后余额：0猫粮");
  });

  it("renders negative session contributions before flooring the unified total", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.confirmCheckoutByIdentity = async () => ({
      playerSettlement: { playerId: "player-1", subtotal: 7, total: 7 },
      settlements: [
        {
          settlement: {
            sessionId: "session-charge",
            label: "标准区间",
            startedAt: "2026-07-10T10:00:00.000Z",
            endedAt: "2026-07-10T11:00:00.000Z",
            settledAt: "2026-07-10T11:00:00.000Z",
            subtotal: 10,
            total: 10,
          },
          chargeItems: [{ label: "标准计费", amount: 10 }],
          adjustments: [],
        },
        {
          settlement: {
            sessionId: "session-discount",
            label: "每小时优惠三元",
            startedAt: "2026-07-10T10:00:00.000Z",
            endedAt: "2026-07-10T11:00:00.000Z",
            settledAt: "2026-07-10T11:00:00.000Z",
            subtotal: -3,
            total: -3,
          },
          chargeItems: [{ label: "相对优惠", amount: -3 }],
          adjustments: [],
        },
      ],
      chargeItems: [],
      adjustments: [],
      checkoutAdjustments: [],
      pricingCapAdjustments: [],
      globalCapWindows: [],
      assetLedgerEntries: [],
      wallet: { balanceBefore: 100, balanceAfter: 93 },
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    const result = await registered.get("logout [target:user]")?.action({
      session: { userId: "123456", senderName: "Tester" },
    });

    expect(result).toContain("标准区间\n游玩时段：");
    expect(result).toContain("游玩时长：1小时0分钟｜计价：10猫粮");
    expect(result).toContain("每小时优惠三元\n游玩时段：");
    expect(result).toContain("游玩时长：1小时0分钟｜计价：-3猫粮");
    expect(result).toContain("计费总价：7猫粮");
    expect(result).not.toContain("计价：0猫粮");
  });

  it("renders a unified discount outside the session it was persisted with", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    const discount = {
      id: "session-1:asset-definition:ticket:freemother:free",
      source: "ticket.freemother",
      label: "老冯",
      amount: -12,
    };
    client.confirmCheckoutByIdentity = async () => ({
      playerSettlement: { playerId: "player-1", subtotal: 12, total: 0 },
      settlements: [{
        settlement: {
          sessionId: "session-1",
          label: "🎵 音乐游戏",
          startedAt: "2026-07-10T07:18:43.664Z",
          endedAt: "2026-07-10T08:13:48.998Z",
          settledAt: "2026-07-10T08:13:48.998Z",
          subtotal: 12,
          total: 0,
        },
        chargeItems: [],
        adjustments: [discount],
      }],
      chargeItems: [],
      adjustments: [discount],
      checkoutAdjustments: [discount],
      pricingCapAdjustments: [],
      globalCapWindows: [],
      assetLedgerEntries: [],
      wallet: { balanceBefore: 0, balanceAfter: 0 },
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    const result = await registered.get("logout [target:user]")?.action({
      session: { userId: "1015929452", senderName: "月" },
    });

    expect(result).toContain("游玩时长：55分钟｜计价：12猫粮");
    expect(result).toContain("计费总价：12猫粮\n\n老冯：-12猫粮\n\n优惠后价格：0猫粮");
    expect(result).toContain("余额：0猫粮");
    expect(result).not.toContain("🎟️");
    expect(result).not.toContain("优惠\n");
    expect(result).not.toContain("  └ 老冯：");
  });

  it("renders global caps as pricing instead of a session discount", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    const capAdjustment = {
      id: "time-cap:cap-config:day:2026-07-10T02:00:00.000Z",
      source: "time.cap:cap-config:day",
      label: "日间",
      amount: -39,
      pricingCapHistory: {
        capConfigId: "cap-config",
        capRuleId: "day",
        capAnchorAt: "2026-07-10T02:00:00.000Z",
        includedPricingConfigIds: ["music", "mahjong"],
        amount: 42,
      },
    };
    const secondCapAdjustment = {
      id: "time-cap:cap-config:night:2026-07-11T14:00:00.000Z",
      source: "time.cap:cap-config:night",
      label: "夜间",
      amount: -5,
      pricingCapHistory: {
        capConfigId: "cap-config",
        capRuleId: "night",
        capAnchorAt: "2026-07-11T14:00:00.000Z",
        includedPricingConfigIds: ["music", "mahjong"],
        amount: 25,
      },
    };
    client.confirmCheckoutByIdentity = async () => ({
      playerSettlement: { playerId: "player-1", subtotal: 111, total: 67 },
      settlements: [{
        settlement: {
          sessionId: "music-1",
          label: "🎵 音乐游戏",
          startedAt: "2026-07-10T07:28:00.000Z",
          endedAt: "2026-07-10T12:42:00.000Z",
          settledAt: "2026-07-10T12:42:00.000Z",
          subtotal: 66,
          total: 66,
        },
        chargeItems: [],
        adjustments: [],
      }, {
        settlement: {
          sessionId: "mahjong-4",
          label: "🀄️ 大洋化学M.LEAGUE联名八口机",
          startedAt: "2026-07-10T11:25:00.000Z",
          endedAt: "2026-07-10T12:19:00.000Z",
          settledAt: "2026-07-10T12:19:00.000Z",
          subtotal: 3,
          total: 0,
        },
        chargeItems: [],
        adjustments: [capAdjustment],
      }],
      chargeItems: [],
      adjustments: [capAdjustment, secondCapAdjustment],
      checkoutAdjustments: [],
      pricingCapAdjustments: [capAdjustment, secondCapAdjustment],
      globalCapWindows: [{
        ruleLabel: "日间",
        windowStartedAt: "2026-07-10T02:00:00.000Z",
        currentAmount: 81,
        amountApplied: 42,
        priceCap: 69,
        paidBefore: 27,
      }, {
        ruleLabel: "夜间",
        windowStartedAt: "2026-07-11T14:00:00.000Z",
        currentAmount: 30,
        amountApplied: 25,
        priceCap: 79,
        paidBefore: 54,
      }],
      assetLedgerEntries: [],
      wallet: { balanceBefore: 252, balanceAfter: 185 },
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });

    const result = await registered.get("logout [target:user]")?.action({
      session: { userId: "1075979543", senderName: "哈基はち" },
    });

    expect(result).toContain("游玩时长：54分钟｜计价：3猫粮");
    expect(result).toContain(
      "封顶：\n" +
      "- 07-10 日间：81 → 42猫粮（上限69，已计27）\n" +
      "- 07-11 夜间：30 → 25猫粮（上限79，已计54）\n\n" +
      "计费总价：67猫粮",
    );
    expect(result).not.toContain("优惠后价格：");
    expect(result).not.toContain("  └ 日间：");
  });

  it("renders multi-session billing format with labels as-is", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    client.previewCheckoutByIdentity = async () => ({
      settlementPreview: { playerId: "player-1", subtotal: 30, total: 30 },
      sessionPreviews: [
        {
          sessionId: "s-1",
          label: "🎮 音游区间",
          startedAt: "2026-06-07T18:00:00.000Z",
          endedAt: "2026-06-07T19:00:00.000Z",
          status: "closed",
          subtotal: 10,
          total: 10,
          chargeItems: [],
          adjustments: [],
        },
        {
          sessionId: "s-2",
          label: "🀄️ 大洋化学",
          startedAt: "2026-06-07T19:00:00.000Z",
          endedAt: "2026-06-07T20:00:00.000Z",
          status: "closed",
          subtotal: 20,
          total: 20,
          chargeItems: [],
          adjustments: [],
        },
      ],
      chargeItems: [],
      adjustments: [],
      checkoutAdjustments: [],
      pricingCapAdjustments: [],
      wallet: { balanceBefore: 42, balanceAfter: 12 },
      globalCapWindows: [],
    });
    const config: PrismKoishiPluginConfig = { client: client as any };
    applyPrismKoishiPlugin(ctx, config);

    const result = await registered.get("billing [target:user]")?.action({
      session: {
        userId: "123456",
        senderName: "Tester",
        bot: { async getUser() { return { name: "Tester" }; } },
      },
    });
    expect(result).toContain("🎮 音游区间");
    expect(result).toContain("🀄️ 大洋化学");
    expect(result).toContain("计费总价：30猫粮");
    expect(result).toContain("当前余额：42猫粮");
    expect(result).toContain("预计结账后余额：12猫粮");
    expect(result).not.toContain("优惠后价格：");
  });

  it("answers billing commands with a notice in a shop that does not bill", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ billingEnabled: false, mahjongTables: [mahjongTable] });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    const player = { session: { userId: "1" } };
    for (const [name, args] of [
      ["login [target:user]", []], ["logout [target:user]", []], ["billing [target:user]", []], ["wallet [target:user]", []],
      ["上桌 [tableId]", ["a"]], ["下桌 [tableId]", []], ["麻将列表", []], ["list [name:text]", []],
    ] as Array<[string, string[]]>) {
      expect(await registered.get(name)!.action(player, ...args)).toBe("本店未启用计费");
    }
    expect(client.calls.map((call) => call[0]).filter((name) => name !== "getBotConfig")).toEqual([]);
    // Binding needs no billing.
    client.confirmPlatformBinding = async () => ({});
    await expect(registered.get("bind <code:string>")!.action(player, "CODE")).resolves.toContain("绑定成功");
  });
});


it("sends every command as a request over one authenticated connection", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const seats: any[] = [];
  const ok = (value: unknown) => ({ status: 200, body: { data: value } });
  const platform = fakePlatform((frame) => {
    if (frame.path.endsWith("/players/by-identity/register"))
      return ok({ player: { id: "player-1", displayName: "Test player", status: "active" } });
    if (frame.path.endsWith("/players/by-identity/session/start"))
      return ok({ session: { id: "entry-1", playerId: "player-1" }, created: true });
    if (frame.path === "integration/mahjong-tables")
      return ok({ tables: [{ id: "table-a", name: "麻将 A 桌", aliases: ["a"], capacity: 1, seats: seats.map((seat) => ({ ...seat, mine: undefined })) }] });
    if (frame.path === "integration/players/by-identity/mahjong") {
      if (frame.body.action === "join") seats.push({ playerId: "player-1", name: "Test player", mine: true, playing: true });
      else seats.length = 0;
      return ok({ mahjong: { capacity: 1, seats: [...seats] } });
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } };
  }, { mahjongTables: [{ id: "table-a", name: "麻将 A 桌", aliases: ["a"], capacity: 1 }] });
  applyPrismKoishiPlugin(createMockKoishiContext(registered), {
    baseUrl: "https://prism.invalid/", shopCode: "audit", integrationToken: "fake-integration-token",
    socket: platform.factory,
  });
  await platform.connected();
  expect(platform.opened).toEqual([{
    url: "wss://prism.invalid/api/v1/shops/audit/integration/ws",
    headers: { Authorization: "Bearer fake-integration-token" },
  }]);
  const sender = { session: { platform: "onebot", userId: "1234" } };
  expect(await registered.get("login [target:user]")!.action(sender)).toContain("入场成功");
  expect(await registered.get("上桌 [tableId]")!.action(sender, "a")).toContain("麻将计费已开始");
  expect(await registered.get("下桌 [tableId]")!.action(sender)).toContain("麻将计费已停止");
  // Admission names no plan and no label: the shop's default plan is the platform's to know.
  const [start] = platform.requests().filter(frame => frame.path.endsWith("/session/start"));
  expect(start.body).toEqual({ identity: { provider: "onebot", subject: "1234" }, displayName: "1234", entry: true });
  expect(platform.requests().filter(frame => frame.path.endsWith("/mahjong")).map(frame => [frame.body.table, frame.body.action]))
    .toEqual([["table-a", "join"], ["table-a", "leave"]]);
  // A registered player is resolved the one way there is.
  expect(platform.requests().some(frame => frame.path.endsWith("/resolve"))).toBe(false);
  // The settings were read once, when the connection opened.
  expect(platform.settingsReads()).toBe(1);
  for (const frame of platform.requests()) {
    expect(frame.path.startsWith("integration/")).toBe(true);
    expect(typeof frame.id).toBe("string");
    if (frame.method === "POST") expect(frame.body.identity).toMatchObject({ provider: "onebot", subject: "1234" });
  }
  // Every request has its own id, so a resend is recognised as the same request.
  expect(new Set(platform.requests().map(frame => frame.id)).size).toBe(platform.requests().length);
  expect(seats).toEqual([]);
});

it("times the same wallet query over HTTP and over the connection", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const platform = fakePlatform((frame) => frame.path === "integration/players/by-identity/wallet"
    ? { status: 200, body: { data: { wallet: [] } }, serverMs: 12 } as any
    : { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } });
  const posts: any[] = [];
  applyPrismKoishiPlugin(createMockKoishiContext(registered), {
    ...connection, socket: platform.factory,
    httpPost: async (url, headers, body) => {
      posts.push({ url, headers, body });
      return { status: 200, headers: new Headers({ "x-response-time": "9ms", "cf-ray": "8f00aa-NRT" }), data: { data: { wallet: [] } } };
    },
  });
  await platform.connected();
  const sender = { session: { userId: "42" } };
  const api = await registered.get("api测速 [count:number]")!.action(sender, "2");
  expect(api).toContain("首次：");
  expect(api).toContain("服务端处理：平均 9 ms");
  expect(api).toContain("节点：NRT");
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject({
    url: "https://prism.test/api/v1/shops/shop-a/integration/players/by-identity/wallet",
    headers: { authorization: "Bearer test-token" },
    body: { identity: { provider: "onebot", subject: "42" } },
  });
  const ws = await registered.get("ws测速 [count:number]")!.action(sender, "3");
  expect(ws).toContain("心跳：最小 ");
  expect(ws).toContain("服务端处理：平均 12 ms");
  expect(platform.requests().filter((frame) => frame.path === "integration/players/by-identity/wallet")).toHaveLength(3);
  // A refused query is reported, not timed.
  const refused = fakePlatform(() => ({ status: 403, body: { error: { code: "PLAYER_DISABLED", message: "玩家已停用" } } }));
  const other = new Map<string, RegisteredCommand>();
  applyPrismKoishiPlugin(createMockKoishiContext(other), { ...connection, socket: refused.factory });
  await refused.connected();
  expect(await other.get("ws测速 [count:number]")!.action(sender, "1")).not.toContain("钱包查询：");
});

it("binds each actual adapter sender without configuration overrides or channel restrictions", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const platform = fakePlatform(() => ({ status: 200, body: { data: { playerId: "p" } } }));
  applyPrismKoishiPlugin(createMockKoishiContext(registered), { ...connection, socket: platform.factory });
  await platform.connected();
  const command = registered.get("bind <code:string>")!;
  expect(await command.action({session:{platform:undefined,userId:"123456"}},"ABCD2345")).toContain("无法获取");
  expect(registered.get("prism.bind <code:string>")!.action).toBeDefined();
  for (const platformName of ["onebot","telegram","discord"]) for (const isDirect of [false,true]) {
    expect(await command.action({session:{platform:platformName,userId:"114514",senderId:"forged",isDirect}},"ABCD2345")).toContain("绑定成功");
  }
  expect(platform.requests().map(frame => [frame.path, frame.body])).toEqual(["onebot","telegram","discord"].flatMap(provider=>Array(2).fill([
    "integration/platform-binding/confirm", {code:"ABCD2345",provider,subject:"114514"},
  ])));
});

it("reports a rejected binding code with the platform's message", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const platform = fakePlatform(() => ({ status: 409, body: { error: { code: "BINDING_CODE_EXPIRED", message: "验证码已过期" } } }));
  applyPrismKoishiPlugin(createMockKoishiContext(registered), { ...connection, socket: platform.factory });
  await platform.connected();
  expect(await registered.get("bind <code:string>")!.action({ session: { platform: "onebot", userId: "1" } }, "X")).toContain("验证码已过期");
});

it("reads the roster over the connection", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const platform = fakePlatform((frame) => frame.path === "integration/roster"
    ? { status: 200, body: { data: { total: 1, groups: [{ kind: "resource", id: "table-a", name: "🀄️ 大洋化学", capacity: 4, members: [{ playerId: "p", displayName: "等待玩家", identities: [] }] }] } } }
    : null, { mahjongTables: [mahjongTable] });
  applyPrismKoishiPlugin(createMockKoishiContext(registered), { ...connection, socket: platform.factory });
  await platform.connected();
  const result = await registered.get("list [name:text]")!.action({session:{userId:"123456"}});
  expect(platform.requests().map(frame => [frame.method, frame.path])).toEqual([["GET", "integration/roster"]]);
  expect(result).toBe("[总计 1 人]\n\n🀄️ 大洋化学 ( 1/4 )：\n- 等待玩家");
});

describe("the bot's settings from the platform", () => {
  it("reads them over the connection before saying hello, and names itself as the shop named it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const platform = fakePlatform(() => null);
    // Hold the answer to the settings read, to see that hello waits for it.
    const factory = platform.factory;
    applyPrismKoishiPlugin(createMockKoishiContext(new Map()), {
      ...connection,
      socket: (url, headers) => {
        const socket = factory(url, headers);
        const send = socket.send.bind(socket);
        socket.send = (data: string) => {
          if (data.includes("\"integration/bot\"")) void held.then(() => send(data));
          else send(data);
        };
        return socket;
      },
    });
    await platform.connected();
    expect(platform.frames).toEqual([]);
    release();
    await platform.connected();
    expect(platform.frames.map((frame) => frame.type === "request" ? `${frame.method} ${frame.path}` : frame.type)).toEqual([
      "GET integration/bot",
      "hello",
    ]);
    // A test platform offers no Home Assistant to watch, so the bot does not offer to.
    expect(platform.hellos()).toEqual([{ type: "hello", name: "前台 Bot" }]);
  });

  it("asks for reminders only when the settings name somewhere to send them", async () => {
    const platform = fakePlatform(() => null, { settings: { idleChannelIds: [], idleReminderMinutes: 5 } });
    applyPrismKoishiPlugin(createMockKoishiContext(new Map()), { ...connection, socket: platform.factory });
    await platform.connected();
    expect(platform.hellos()).toEqual([{ type: "hello", name: "前台 Bot" }]);

    const never = fakePlatform(() => null, { settings: { idleChannelIds: ["onebot:1"], idleReminderMinutes: 0 } });
    applyPrismKoishiPlugin(createMockKoishiContext(new Map()), { ...connection, socket: never.factory });
    await never.connected();
    expect(never.hellos()).toEqual([{ type: "hello", name: "前台 Bot" }]);
  });

  it("announces idle power-offs where the settings say, as early as they say", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const broadcasts: Array<[string[], string]> = [];
    const platform = fakePlatform(() => null, { settings: { idleChannelIds: ["onebot:123456789"], idleReminderMinutes: 5 } });
    const now = new Date("2026-10-21T12:00:00Z");
    applyPrismKoishiPlugin({
      ...createMockKoishiContext(registered),
      async broadcast(channels: string[], content: string) { broadcasts.push([channels, content]); },
    }, { ...connection, socket: platform.factory, now: () => now });
    await platform.connected();
    expect(platform.hellos()).toEqual([{ type: "hello", name: "前台 Bot", reminderLeadSeconds: 300 }]);
    platform.push("idle.reminder", { reason: "device_idle", at: now.getTime() + 5 * 60_000, devices: [{ id: "m1", name: "舞萌" }, { id: "m2", name: "中二" }] });
    platform.push("idle.reminder", { reason: "shop_empty", at: now.getTime() + 4 * 60_000, devices: [{ id: "m1", name: "舞萌" }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broadcasts).toEqual([
      [["onebot:123456789"], "舞萌、中二 闲置中，5 分钟后关机。已入场的玩家发送 keep 设备名 可以延迟"],
      [["onebot:123456789"], "店里没人，4 分钟后全部关机"],
    ]);
  });

  it("rereads them and says hello again when the shop changes them", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const platform = fakePlatform(() => ({ status: 200, body: { session: { id: "s" }, created: true } }));
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { ...connection, socket: platform.factory });
    await platform.connected();
    const player = { session: { userId: "1" } };
    await expect(registered.get("login [target:user]")!.action(player)).resolves.toBe("✅ 入场成功");

    platform.change({ bot: { id: "bot-1", name: "收银台" }, settings: { playerCommands: "readonly", readOnlyNotice: "去网页入场", idleChannelIds: ["onebot:9"] } });
    await platform.connected();
    expect(platform.settingsReads()).toBe(2);
    expect(platform.hellos().at(-1)).toEqual({ type: "hello", name: "收银台", reminderLeadSeconds: 300 });
    await expect(registered.get("login [target:user]")!.action(player)).resolves.toBe("去网页入场");
    // The settings were read when told, not again for the command.
    expect(platform.settingsReads()).toBe(2);
  });

  it("answers only that it is disabled while the shop has disabled it", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const platform = fakePlatform(() => ({ status: 200, body: { wallet: [] } }));
    platform.refuse(403, "BOT_DISABLED", "这个 Bot 已停用");
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { ...connection, socket: platform.factory });
    await platform.connected();
    // It stays connected, offering nothing, so the shop can enable it again.
    expect(platform.hellos()).toEqual([{ type: "hello" }]);
    const player = { session: { userId: "1" } };
    for (const name of ["wallet [target:user]", "login [target:user]", "list [name:text]"]) {
      expect(await registered.get(name)!.action(player)).toBe("Bot 已被店铺停用");
    }
    expect(await registered.get("bind <code:string>")!.action(player, "CODE")).toBe("Bot 已被店铺停用");
    expect(platform.requests()).toEqual([]);

    platform.change({});
    await platform.connected();
    expect(platform.hellos().at(-1)).toEqual({ type: "hello", name: "前台 Bot" });
    expect(await registered.get("wallet [target:user]")!.action(player)).toContain("钱包余额");
  });

  it("takes staff from the platform identities the shop bound", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient({ staff: [{ provider: "onebot", subject: "114514" }] });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
    for (const platform of ["onebot", "telegram"]) {
      await registered.get("billing [target:user]")!.action({ session: { platform, userId: "114514", senderName: platform } });
      await registered.get("wallet [target:user]")!.action({ session: { platform, userId: "114514" } });
      expect(client.calls.find((call: any) => call[0] === "previewCheckoutByIdentity" && call[1]?.provider === platform)?.[1])
        .toMatchObject({ provider: platform, subject: "114514", displayName: platform });
    }
    // The same number on another platform is someone else.
    const telegram = { session: { platform: "telegram", userId: "114514" } };
    expect(await registered.get("login [target:user]")!.action(telegram, "telegram:someone")).toBe("权限不足");
    const onebot = { session: { platform: "onebot", userId: "114514" } };
    expect(await registered.get("login [target:user]")!.action(onebot, "telegram:someone")).toBe("请在目标平台使用该命令");
    expect(await registered.get("login [target:user]")!.action(onebot, "onebot:someone")).toContain("入场成功");
  });
});

/** A Home Assistant the test drives by hand: every connection the bot opens to it is kept. */
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
  it("says it can, by the name the shop gave it, so the platform may ask", async () => {
    const platform = fakePlatform(() => null, { bot: { id: "bot-1", name: "前台" } });
    const home = fakeHomeAssistant();
    applyPrismKoishiPlugin(createMockKoishiContext(new Map()), { ...connection, socket: platform.factory, haSocket: home.factory });
    await platform.connected();
    expect(platform.hellos()).toEqual([{ type: "hello", name: "前台", ha: true }]);
  });

  it("does not offer to watch when the settings say not to, and ignores a watch sent anyway", async () => {
    const off = fakePlatform(() => null, { settings: { watchHomeAssistant: false } });
    const home = fakeHomeAssistant();
    applyPrismKoishiPlugin(createMockKoishiContext(new Map()), { ...connection, socket: off.factory, haSocket: home.factory });
    await off.connected();
    expect(off.hellos()).toEqual([{ type: "hello", name: "前台 Bot" }]);
    off.pushFrame({ type: "ha.watch", watch });
    expect(home.opened).toEqual([]);
  });

  it("stops watching when the shop turns it off, and offers again when turned back on", async () => {
    const platform = fakePlatform(() => null);
    const home = fakeHomeAssistant();
    applyPrismKoishiPlugin(createMockKoishiContext(new Map()), { ...connection, socket: platform.factory, haSocket: home.factory });
    await platform.connected();
    platform.pushFrame({ type: "ha.watch", watch });
    expect(home.sockets).toHaveLength(1);

    platform.change({ settings: { watchHomeAssistant: false } });
    await platform.connected();
    expect(home.sockets[0]!.closed).toBe(true);
    // The platform hands the watch on when it hears this hello.
    expect(platform.hellos().at(-1)).toEqual({ type: "hello", name: "前台 Bot" });

    platform.change({ settings: { watchHomeAssistant: true } });
    await platform.connected();
    expect(platform.hellos().at(-1)).toEqual({ type: "hello", name: "前台 Bot", ha: true });
    platform.pushFrame({ type: "ha.watch", watch });
    expect(home.sockets).toHaveLength(2);
  });

  it("subscribes when the platform asks and reports what it sees to the platform", async () => {
    const platform = fakePlatform(() => null);
    const home = fakeHomeAssistant();
    applyPrismKoishiPlugin(createMockKoishiContext(new Map()), { ...connection, socket: platform.factory, haSocket: home.factory });
    await platform.connected();
    platform.pushFrame({ type: "ha.watch", watch });
    // Home Assistant is reached by the address given, and signed into with the token given, not the bot's own.
    expect(home.opened).toEqual([{ url: "ws://ha.local:8123/api/websocket", headers: {} }]);
    await platform.connected();
    home.say(0, { type: "auth_required" });
    expect(home.sockets[0]!.sent[0]).toEqual({ type: "auth", access_token: "reader" });
    home.say(0, { type: "auth_ok" });
    expect(home.sockets[0]!.sent[1]).toEqual({ id: 1, type: "subscribe_entities", entity_ids: ["switch.a"] });
    home.say(0, { id: 1, type: "event", event: { a: { "switch.a": { s: "on", a: {}, lc: 10, lu: 10 } } } });
    const reports = platform.frames.filter((frame) => frame.type === "ha");
    expect(reports).toEqual([
      { type: "ha", method: "ha.status", params: { term: 5, connection: "ha_1", connected: true, error: null } },
      { type: "ha", method: "ha.states", params: { term: 5, connection: "ha_1", full: true, states: [{ entity_id: "switch.a", state: "on", last_changed: 10, last_updated: 10, attributes: {} }] } },
    ]);
  });

  it("lets go of Home Assistant when the platform says so, or an unreadable watch arrives", async () => {
    const platform = fakePlatform(() => null);
    const home = fakeHomeAssistant();
    applyPrismKoishiPlugin(createMockKoishiContext(new Map()), { ...connection, socket: platform.factory, haSocket: home.factory });
    await platform.connected();
    platform.pushFrame({ type: "ha.watch", watch });
    await platform.connected();
    platform.pushFrame({ type: "ha.unwatch" });
    expect(home.sockets[0]!.closed).toBe(true);

    platform.pushFrame({ type: "ha.watch", watch });
    expect(home.sockets).toHaveLength(2);
    // The platform has nothing for it now: a watch it cannot read means stop.
    platform.pushFrame({ type: "ha.watch", watch: { term: "x" } });
    expect(home.sockets[1]!.closed).toBe(true);
  });

  it("lets go of Home Assistant when the platform connection drops, as the platform forgets the watch", async () => {
    const platform = fakePlatform(() => null);
    const home = fakeHomeAssistant();
    applyPrismKoishiPlugin(createMockKoishiContext(new Map()), { ...connection, socket: platform.factory, haSocket: home.factory });
    await platform.connected();
    platform.pushFrame({ type: "ha.watch", watch });
    await platform.connected();
    platform.drop();
    expect(home.sockets[0]!.closed).toBe(true);
  });
});

it("lets an entered player keep a device on, even in read-only mode", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const platform = fakePlatform((frame) => frame.body?.action?.type === "power.keep"
    ? { status: 200, body: { data: { action: { status: "succeeded", payload: { deviceLabel: "舞萌" } } } } }
    : null, { settings: { playerCommands: "readonly", readOnlyNotice: "请扫码操作" } });
  applyPrismKoishiPlugin(createMockKoishiContext(registered), { ...connection, socket: platform.factory });
  await platform.connected();
  expect(await registered.get("keep <deviceRef>")!.action({ session: { platform: "onebot", userId: "1" } }, "舞萌")).toContain("舞萌 已延迟关机");
  const [frame] = platform.requests();
  expect(frame.path).toBe("integration/players/by-identity/device-actions");
  expect(frame.body.action).toEqual({ type: "power.keep" });
  expect(frame.body.target).toEqual({ kind: "facility", ref: "舞萌" });
});

it("fails a command at once while the connection is down, instead of queueing it", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const sent: string[] = [];
  // A connection that never opens, as while the platform is unreachable.
  const socket = { readyState: 0, addEventListener() {}, send(data: string) { sent.push(data); }, close() {} };
  applyPrismKoishiPlugin(createMockKoishiContext(registered), { ...connection, socket: () => socket });
  expect(await registered.get("wallet [target:user]")!.action({ session: { userId: "1" } })).toBe("操作失败，暂时连不上服务器。");
  expect(sent).toEqual([]);
});

it("leaves read-only players lookups, binding and redeeming while staff keep every command", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const client = createDefaultClient({
    settings: { playerCommands: "readonly", readOnlyNotice: "请扫码操作" },
    staff: [{ provider: "onebot", subject: "999" }],
  });
  applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
  const player = { session: { platform: "onebot", userId: "114514" } };
  const effects: [string, string[]][] = [
    ["login [target:user]", []], ["入场 [target:user]", []], ["logout [target:user]", []],
    ["mahjong <tableId>", ["a"]], ["上桌 [tableId]", ["a"]], ["下桌 [tableId]", []],
    ["lock", []], ["on <deviceRef>", ["maimai"]], ["off <deviceRef>", ["maimai"]],
    ["coin <deviceRef> [count]", ["maimai"]], ["scan <deviceRef>", ["maimai"]],
  ];
  for (const [name, args] of effects) expect(await registered.get(name)!.action(player, ...args)).toBe("请扫码操作");
  expect(client.calls.some((call: any) => ["startSessionByIdentity", "confirmCheckoutByIdentity", "mahjongByIdentity"].includes(call[0]))).toBe(false);
  for (const name of ["wallet [target:user]", "billing [target:user]", "history [target:user]", "items [target:user]", "list [name:text]", "show [deviceId]", "麻将列表", "versions"]) {
    expect(await registered.get(name)!.action(player)).not.toBe("请扫码操作");
  }
  expect(await registered.get("redeem <code>")!.action(player, "CODE")).not.toBe("请扫码操作");
  expect(registered.has("register")).toBe(false);
  // The same number on another platform is not staff.
  expect(await registered.get("login [target:user]")!.action({ session: { platform: "telegram", userId: "999" } })).toBe("请扫码操作");
  const staff = { session: { platform: "onebot", userId: "999" } };
  expect(await registered.get("login [target:user]")!.action(staff)).toContain("入场成功");
  expect(await registered.get("login [target:user]")!.action(staff, "onebot:114514")).toContain("入场成功");
});

it("sends receipts only to staff reachable through the sender adapter, and only when the settings say so", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const client = createDefaultClient({
    settings: { receiptsToStaff: true },
    staff: [{ provider: "onebot", subject: "114514" }, { provider: "telegram", subject: "114514" }],
  });
  const calls: any[] = [];
  applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
  const logout = (platform: string) => registered.get("logout [target:user]")!.action({ session: {
    platform, userId: "player", bot: { broadcast: async (ids: string[]) => { calls.push([platform, ids]); } },
  } });
  for (const platform of ["onebot", "telegram", "discord"]) await logout(platform);
  expect(calls).toEqual([["onebot", ["private:114514"]], ["telegram", ["private:114514"]]]);

  client.bot = botConfig({ settings: { receiptsToStaff: false }, staff: [{ provider: "onebot", subject: "114514" }] });
  const quiet = new Map<string, RegisteredCommand>();
  applyPrismKoishiPlugin(createMockKoishiContext(quiet), { client: client as any });
  calls.length = 0;
  await quiet.get("logout [target:user]")!.action({ session: { platform: "onebot", userId: "player", bot: { broadcast: async (ids: string[]) => { calls.push(ids); } } } });
  expect(calls).toEqual([]);
});

it("renders API-carried shop offsets even when the Bot host uses another zone", async () => {
  const registered = new Map<string, RegisteredCommand>();
  const client = createDefaultClient({ currencyName: "元" });
  const preview = await client.previewCheckoutByIdentity({});
  preview.sessionPreviews[0]!.startedAt = "2026-10-03T10:08:00+08:00";
  preview.sessionPreviews[0]!.endedAt = "2026-10-03T11:54:00+08:00";
  preview.settlementPreview.previewedAt = "2026-10-03T11:54:00+08:00";
  client.previewCheckoutByIdentity = async () => preview;
  applyPrismKoishiPlugin(createMockKoishiContext(registered), { client: client as any });
  const result = await registered.get("billing [target:user]")!.action({ session: { userId: "123" } });
  expect(result).toContain("游玩时间：10:08–11:54（UTC+08:00）");
  expect(result).toContain("游玩时段：10:08-11:54");
  expect(result).toContain("游玩时长：1小时46分钟");
  expect(result).toContain("计费总价：25元");
});
