import { describe, expect, it } from "bun:test";
import { applyPrismKoishiPlugin, PrismBotClientError, type PrismKoishiPluginConfig } from "../src";

type RegisteredCommand = {
  description: string;
  action: (sessionContext: any, ...args: string[]) => Promise<string> | string;
};

function createMockKoishiContext(registered: Map<string, RegisteredCommand>) {
  return {
    command(name: string, description: string) {
      const command: RegisteredCommand = { description, action: () => "" };
      registered.set(name, command);
      return {
        action(handler: RegisteredCommand["action"]) {
          command.action = handler;
          return this;
        },
      };
    },
    setInterval() {},
  };
}

function createDefaultClient() {
  const calls: any[] = [];
  return {
    calls,
    async resolveOrRegisterIdentity(input: unknown) {
      calls.push(["resolveOrRegisterIdentity", input]);
      return { id: "player-1", displayName: "Neri", status: "active" };
    },
    async startSessionByIdentity(input: unknown, body?: unknown) {
      calls.push(["startSessionByIdentity", input, body]);
      return {
        session: {
          id: "session-1",
          playerId: "player-1",
          startedAt: "2026-06-07T10:00:00.000Z",
          status: "active",
        },
      };
    },
    async previewCheckoutByIdentity(input: unknown) {
      calls.push(["previewCheckoutByIdentity", input]);
      return {
        settlementPreview: {
          playerId: "player-1",
          subtotal: 25,
          total: 22,
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
            adjustments: [{ label: "月卡折扣", amount: -3 }],
          },
        ],
        adjustments: [{ label: "月卡折扣", amount: -3 }],
        assetHoldings: [{ assetCode: "paid", quantity: 100 }],
      };
    },
    async confirmCheckoutByIdentity(input: unknown) {
      calls.push(["confirmCheckoutByIdentity", input]);
      return {
        settlement: { playerId: "player-1", subtotal: 25, total: 22 },
        settlements: [],
        chargeItems: [],
        adjustments: [],
        assetHoldings: [{ assetCode: "paid", quantity: 78 }],
      };
    },
    async stopSessionByIdentity(input: unknown, sessionId: string) {
      calls.push(["stopSessionByIdentity", input, sessionId]);
      return {};
    },
    async getWalletByIdentity(input: unknown) {
      calls.push(["getWalletByIdentity", input]);
      return {
        total: { available: 100, all: 100 },
        paid: { available: 60 },
        free: { available: 40 },
      };
    },
    async getAssetsByIdentity(input: unknown) {
      calls.push(["getAssetsByIdentity", input]);
      return { holdings: [{ assetName: "Monthly pass", quantity: 1, expireAt: null }] };
    },
    async getSessionHistoryByIdentity(input: unknown) {
      calls.push(["getSessionHistoryByIdentity", input]);
      return { sessions: [{ sessionId: "session-1", createdAt: "2026-06-07T18:00:00.000Z", closedAt: "2026-06-07T19:00:00.000Z", total: 25 }] };
    },
    async requestDeviceCommandByIdentity(input: unknown, command: unknown) {
      calls.push(["requestDeviceCommandByIdentity", input, command]);
      return { command: { id: "command-1" } };
    },
    async requestScanByIdentity(input: unknown, scan: unknown) {
      calls.push(["requestScanByIdentity", input, scan]);
      return { command: { id: "scan-1" } };
    },
    async redeemCodeByIdentity(input: unknown, code: string) {
      calls.push(["redeemCodeByIdentity", input, code]);
      return { holdings: [{ assetName: "Coupon", quantity: 1 }] };
    },
    async listActiveSessions() {
      calls.push(["listActiveSessions"]);
      return {
        sessions: [
          {
            id: "session-1",
            playerId: "player-1",
            playerDisplayName: "Player 296",
            startedAt: "2026-07-08T11:38:31.000Z",
            label: "音游区间",
            identities: [{ provider: "qq", subject: "2034994588" }],
          },
        ],
      };
    },
    async listDeviceStates() {
      calls.push(["listDeviceStates"]);
      return { deviceStates: [{ deviceId: "ai-1", label: "maimai", state: { state: "on" } }] };
    },
    async adjustAssetsByIdentity(identity: unknown, adjustments: unknown[]) {
      calls.push(["adjustAssetsByIdentity", identity, adjustments]);
      return { holdings: [] };
    },
    async checkoutWithOverrideByIdentity(identity: unknown, total: number, reason: string) {
      calls.push(["checkoutWithOverrideByIdentity", identity, total, reason]);
      return { settlement: { total } };
    },
  };
}

describe("applyPrismKoishiPlugin", () => {
  it("registers all player commands and basic flows work", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      loginPricingConfigIds: ["pricing-music-standard"],
      loginSessionLabel: "音游区间",
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      client: client as any,
    };

    applyPrismKoishiPlugin(ctx, config);

    const expected = [
      "register",
      "login [target:user]",
      "入场 [target:user]",
      "mahjong <tableId>",
      "上桌 <tableId>",
      "下桌 <tableId>",
      "logout [target:user]",
      "billing [target:user]",
      "wallet [target:user]",
      "items [target:user]",
      "list",
      "show [deviceId]",
      "history [target:user]",
      "lock",
      "on <deviceId>",
      "off <deviceId>",
      "coin <deviceId> [count]",
      "scan <deviceId> <subject>",
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
    expect(billingResult).toContain("玩家：Tester（QQ：123456）");
    expect(billingResult).toContain("⏰ 游玩时间：");
    expect(billingResult).toContain("音游区间");
    expect(billingResult).toContain("游玩时长：1小时0分钟｜消费：22猫粮");
    expect(billingResult).toContain("  └ 月卡折扣：-3猫粮");
    expect(billingResult).toContain("计费总价：25猫粮");
    expect(billingResult).toContain("优惠后价格：22猫粮");
    expect(billingResult).toContain("扣款后余额：100猫粮");
    expect(billingResult).not.toContain("玩家ID：");
    expect(billingResult).not.toContain("————————————");
    expect(billingResult).not.toContain("　｜　");

    const listResult = await registered.get("list")?.action({ session: { userId: "123456" } });
    expect(listResult).toContain("[总计 1 人]");
    expect(listResult).toContain("Player 296");
  });

  it("quotes command replies and notifies configured logout recipients", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    const broadcasts: Array<[string[], string]> = [];
    applyPrismKoishiPlugin(createMockKoishiContext(registered), {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      staffUserIds: ["staff-1"],
      logoutNotifyUserIds: ["staff-1", "audit-1"],
      client: client as any,
    });
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
    expect(broadcasts[0][0]).toEqual(["staff-1", "audit-1"]);
    expect(broadcasts[0][1]).toContain("✅ 退场成功 · 结算账单");
    expect(broadcasts[0][1]).toContain("玩家：player-1（QQ：123456）");
    expect(broadcasts[0][1]).not.toContain("quote");
  });

  it("registers administrator shortcuts with target authorization and staff writes", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      enableStaffCommands: true,
      staffUserIds: ["admin"],
      client: client as any,
    };
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
    await expect(registered.get("login [target:user]")?.action(adminContext, "onebot:262661418")).resolves.toContain("已为用户 262661418 入场");
    await expect(registered.get("login [target:user]")?.action(playerContext, "target-qq")).resolves.toBe("权限不足");
    await expect(registered.get("add <target:user> <amount:number>")?.action(adminContext, "target-qq", "10")).resolves.toContain("已为用户");
    await expect(registered.get("del <target:user> <amount:number>")?.action(adminContext, "target-qq", "3")).resolves.toContain("已为用户");
    await expect(registered.get("overwrite <target:user> <amount:number> [reason:text]")?.action(adminContext, "target-qq", "30")).resolves.toContain("已为用户");

    expect(client.calls).toContainEqual(["adjustAssetsByIdentity", {
      provider: "qq", subject: "target-qq", autoRegister: true, displayName: "target-qq",
    }, [{
      assetType: "currency",
      assetCode: "paid",
      quantityDelta: 10,
      reason: "Koishi 管理员增加余额",
    }]]);
    expect(client.calls).toContainEqual(["adjustAssetsByIdentity", {
      provider: "qq", subject: "target-qq", autoRegister: true, displayName: "target-qq",
    }, [{
      assetType: "currency",
      assetCode: "paid",
      quantityDelta: -3,
      reason: "Koishi 管理员扣除余额",
    }]]);
    expect(client.calls).toContainEqual(["checkoutWithOverrideByIdentity", {
      provider: "qq", subject: "target-qq", autoRegister: true, displayName: "target-qq",
    }, 30, "Koishi 管理员手动调价"]);
    expect(client.calls).toContainEqual(["startSessionByIdentity", {
      provider: "qq", subject: "262661418", autoRegister: true, displayName: "262661418",
    }, undefined]);
  });

  it("denies targeted administrator shortcuts when the staff whitelist is empty", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();

    applyPrismKoishiPlugin(ctx, {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      enableStaffCommands: true,
      staffUserIds: [],
      client: client as any,
    });

    await expect(
      registered.get("login [target:user]")?.action({ session: { userId: "unlisted-admin" } }, "target-qq"),
    ).resolves.toBe("权限不足");
  });

  it("uses platform display name when resolver is provided", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      resolveDisplayName: () => Promise.resolve("🎀hanahana🎀"),
      client: client as any,
    };
    applyPrismKoishiPlugin(ctx, config);
    const listResult = await registered.get("list")?.action({ session: { userId: "123456" } });
    expect(listResult).toContain("🎀hanahana🎀");
  });

  it("groups list by music players and mahjong tables", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    client.resolveOrRegisterIdentity = async (input: { subject: string }) => ({
      id: `player-${input.subject}`,
      displayName: `Player ${input.subject}`,
    });
    client.listActiveSessions = async () => ({
      sessions: [
        { id: "music-1", playerId: "player-1", playerDisplayName: "Player 1", label: "音游区间", identities: [{ provider: "qq", subject: "1" }] },
        { id: "music-2", playerId: "player-2", playerDisplayName: "Player 2", label: "音游区间", identities: [{ provider: "qq", subject: "2" }] },
        { id: "music-3", playerId: "player-3", playerDisplayName: "Player 3", label: "音游区间", identities: [{ provider: "qq", subject: "3" }] },
        { id: "mahjong-3", playerId: "player-3", playerDisplayName: "Player 3", label: "🀄️ 大洋化学八口麻将机", identities: [{ provider: "qq", subject: "3" }] },
        { id: "mahjong-4", playerId: "player-4", playerDisplayName: "Player 4", label: "🀄️ 大洋化学八口麻将机", identities: [{ provider: "qq", subject: "4" }] },
        { id: "music-5", playerId: "player-5", playerDisplayName: "Player 5", label: "音游区间", identities: [{ provider: "qq", subject: "5" }] },
      ],
    });
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      mahjongTables: "a,四麻A : 🀄️ 大洋化学八口麻将机 = pricing-mahjong-a",
      mahjongTableSize: 4,
      resolveDisplayName: (subject) => `Player ${subject}`,
      client: client as any,
    };
    applyPrismKoishiPlugin(ctx, config);

    await expect(registered.get("上桌 <tableId>")?.action({ session: { userId: "5", senderName: "Player 5" } }, "a")).resolves.toContain("已经开始计费");
    const result = await registered.get("list")?.action({ session: { userId: "1" } });

    expect(result).toContain("[总计 5 人]");
    expect(result).toContain("🎵 音乐游戏 ( 3人 )：\n- Player 1, - Player 2, - Player 5");
    expect(result).toContain("🀄️ 大洋化学八口麻将机 ( 2/4 )：\n- Player 3, - Player 4");
    expect(result).not.toContain("音游区间");
  });

  it("uses the configured mahjong prefix when rendering fallback table labels", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.listActiveSessions = async () => ({
      sessions: [
        { id: "mahjong-1", playerId: "player-1", playerDisplayName: "Player 1", label: "牌桌 a", identities: [{ provider: "qq", subject: "1" }] },
      ],
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      mahjongTables: "a = pricing-mahjong-a",
      mahjongLabelPrefix: "牌桌",
      client: client as any,
    });

    const result = await registered.get("list")?.action({ session: { userId: "1" } });

    expect(result).toContain("🀄️ 牌桌 a ( 1/4 )：\n- Player 1");
  });

  it("uses a later session backend name after an earlier identity fallback", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    client.listActiveSessions = async () => ({
      sessions: [
        { id: "music-1", playerId: "player-1", label: "音游区间", identities: [{ provider: "qq", subject: "first-subject" }] },
        { id: "music-2", playerId: "player-1", playerDisplayName: "Later backend name", label: "音游区间" },
      ],
    });
    applyPrismKoishiPlugin(createMockKoishiContext(registered), {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      client: client as any,
    });

    const result = await registered.get("list")?.action({ session: { userId: "1" } });

    expect(result).toContain("- Later backend name");
    expect(result).not.toContain("- first-subject");
  });

  it("shows device states and power commands", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      client: client as any,
    };
    applyPrismKoishiPlugin(ctx, config);
    const list = await registered.get("show [deviceId]")?.action({ session: { userId: "123456" } });
    expect(list).toContain("maimai: on");
    const res = await registered.get("show [deviceId]")?.action({ session: { userId: "123456" } }, "ai-1");
    expect(res).toContain("maimai: on");
    const onResult = await registered.get("on <deviceId>")?.action({ session: { userId: "123456" } }, "ai-1");
    expect(onResult).toContain("ai-1 启动成功");
    const coinResult = await registered.get("coin <deviceId> [count]")?.action({ session: { userId: "123456" } }, "ai-1", "2");
    expect(coinResult).toContain("2 个币");
    const scanResult = await registered.get("scan <deviceId> <subject>")?.action({ session: { userId: "123456" } }, "aime-1", "card-4321");
    expect(scanResult).toContain("尾号为 4321");
    const redeemResult = await registered.get("redeem <code>")?.action({ session: { userId: "123456" } }, "PRISM-2026");
    expect(redeemResult).toContain("兑换成功");
  });

  it("rejects mahjong seating before the player enters", async () => {
    const client = createDefaultClient();
    client.listActiveSessions = async () => ({ sessions: [] });
    const registered = new Map<string, RegisteredCommand>();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      mahjongTables: "a,四麻A : 🀄️ M.LEAGUE联名比赛专用机 = pricing-mahjong-a",
      mahjongTableSize: 4,
      client: client as any,
    };
    applyPrismKoishiPlugin(createMockKoishiContext(registered), config);

    await expect(
      registered.get("上桌 <tableId>")?.action(
        { session: { userId: "2034994588", senderName: "hanahana" } },
        "a",
      ),
    ).resolves.toContain("请先入场");
    expect(client.calls.filter((call) => call[0] === "startSessionByIdentity")).toHaveLength(0);
  });

  it("registers and runs mahjong commands", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      mahjongTables: "a,四麻A : 🀄️ M.LEAGUE联名比赛专用机 = pricing-mahjong-a",
      mahjongTableSize: 4,
      client: client as any,
    };
    applyPrismKoishiPlugin(ctx, config);

    const joinResult = await registered.get("上桌 <tableId>")?.action({ session: { userId: "2034994588", senderName: "hanahana" } }, "a");
    expect(joinResult).toContain("已加入 🀄️ M.LEAGUE联名比赛专用机");
    expect(joinResult).toContain("1/4 人");

    const leaveResult = await registered.get("下桌 <tableId>")?.action({ session: { userId: "2034994588", senderName: "hanahana" } }, "a");
    expect(leaveResult).toContain("已离开");
  });

  it("synchronizes mahjong state from backend active sessions", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq", autoRegister: true, defaultDoorDeviceId: "front-door", defaultScanProvider: "aime", currencyName: "猫粮",
      mahjongTables: "a : 大洋化学 = pricing-mahjong-a", mahjongTableSize: 1, client: client as any,
    };
    applyPrismKoishiPlugin(createMockKoishiContext(registered), config);
    await registered.get("上桌 <tableId>")?.action({ session: { userId: "2034994588" } }, "a");
    client.listActiveSessions = async () => ({ sessions: [{ id: "music-session", playerId: "player-1", label: "音游区间", identities: [{ provider: "qq", subject: "2034994588" }] }] });
    await expect(registered.get("上桌 <tableId>")?.action({ session: { userId: "2034994588" } }, "a")).resolves.toContain("大洋化学已满，麻将计费已开始");

    const recovered = new Map<string, RegisteredCommand>();
    client.listActiveSessions = async () => ({ sessions: [{ id: "mahjong-session", playerId: "player-1", label: "大洋化学", identities: [{ provider: "qq", subject: "2034994588" }] }] });
    applyPrismKoishiPlugin(createMockKoishiContext(recovered), config);
    await expect(recovered.get("下桌 <tableId>")?.action({ session: { userId: "2034994588" } }, "a")).resolves.toContain("已离开 大洋化学");
    expect(client.calls).toContainEqual(["stopSessionByIdentity", expect.anything(), "mahjong-session"]);
  });

  it("does not register legacy admin commands", () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      enableStaffCommands: true,
      staffUserIds: [],
      client: client as any,
    };
    applyPrismKoishiPlugin(ctx, config);
    expect([...registered.keys()].some((name) => name.startsWith("admin."))).toBe(false);
  });

  it("denies staff commands when not enabled", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      client: client as any,
    };
    applyPrismKoishiPlugin(ctx, config);
    const adminNames = [...registered.keys()].filter((name) => name.startsWith("admin."));
    expect(adminNames).toEqual([]);
  });

  it("fetches platform nickname via bot.getUser during login", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      client: client as any,
    };
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
      provider: "qq",
      subject: "qq-user-123",
      autoRegister: true,
      displayName: "Dynamic QQ Nickname",
    });
  });

  it("passes configured loginSessionLabel in the login request body", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      loginPricingConfigIds: ["pricing-music-standard"],
      loginSessionLabel: "自定义标签",
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      client: client as any,
    };
    applyPrismKoishiPlugin(ctx, config);

    await expect(registered.get("login [target:user]")?.action({ session: { userId: "123456", senderName: "Tester" } })).resolves.toContain("✅ 入场成功");

    const startSessionCall = client.calls.find((c) => c[0] === "startSessionByIdentity");
    expect(startSessionCall).toBeDefined();
    expect(startSessionCall[2]).toEqual({ pricingConfigIds: ["pricing-music-standard"], label: "自定义标签" });
  });

  it("prevents duplicate login when backend reports DUPLICATE_SESSION_LABEL", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    client.startSessionByIdentity = async () => {
      throw new PrismBotClientError("Player already has an active session with label '音游区间'.", "DUPLICATE_SESSION_LABEL", 409, {});
    };
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      loginSessionLabel: "音游区间",
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      client: client as any,
    };
    applyPrismKoishiPlugin(ctx, config);

    const result = await registered.get("login [target:user]")?.action({ session: { userId: "123456", senderName: "Tester" } });
    expect(result).toContain("❌ 您已经处于入场状态");
    expect(result).toContain("请勿重复发送入场命令");
  });

  it("renders a concise zero-cost checkout receipt", async () => {
    const registered = new Map<string, RegisteredCommand>();
    const ctx = createMockKoishiContext(registered);
    const client = createDefaultClient();
    client.confirmCheckoutByIdentity = async () => ({
      settlement: { playerId: "player-1", subtotal: 0, total: 0 },
      settlements: [{
        settlement: {
          sessionId: "s-1",
          label: "音游区间",
          startedAt: "2026-06-07T18:00:00.000Z",
          settledAt: "2026-06-07T19:00:00.000Z",
          subtotal: 0,
          total: 0,
        },
        chargeItems: [],
        adjustments: [],
      }],
      chargeItems: [],
      adjustments: [],
      assetHoldings: [{ assetCode: "paid", quantity: 9791 }],
    });
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      client: client as any,
    };
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
          adjustments: [],
        },
      ],
      adjustments: [],
      assetHoldings: [{ assetCode: "paid", quantity: 42 }],
    });
    const config: PrismKoishiPluginConfig = {
      provider: "qq",
      autoRegister: true,
      defaultDoorDeviceId: "front-door",
      defaultScanProvider: "aime",
      currencyName: "猫粮",
      client: client as any,
    };
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
    expect(result).toContain("扣款后余额：42猫粮");
    expect(result).not.toContain("优惠后价格：");
  });
});
