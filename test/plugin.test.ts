import { describe, expect, it } from "bun:test";
import { applyPrismKoishiPlugin, type PrismKoishiPluginConfig } from "../src";

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
          },
        ],
        adjustments: [{ amount: -3 }],
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
    async listStaffPlayers() {
      calls.push(["listStaffPlayers"]);
      return { players: [{ id: "player-1", displayName: "Neri", status: "active", walletTotal: 100 }] };
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
    async createStaffPlayer(displayName: string) {
      calls.push(["createStaffPlayer", displayName]);
      return { player: { id: "player-new", displayName } };
    },
    async grantStaffAssets(playerId: string, grants: any[]) {
      calls.push(["grantStaffAssets", playerId, grants]);
      return { holdings: [] };
    },
    async createStaffRedeemCode(input: unknown) {
      calls.push(["createStaffRedeemCode", input]);
      return { redeemCode: { id: "code-1", code: "PRISM-2026" } };
    },
    async staffCheckout(playerId: string) {
      calls.push(["staffCheckout", playerId]);
      return { settlement: { total: 25 } };
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
      "login",
      "入场",
      "mahjong <tableId>",
      "上桌 <tableId>",
      "下桌 <tableId>",
      "logout",
      "billing",
      "wallet",
      "items",
      "list",
      "show [deviceId]",
      "history",
      "lock",
      "on <deviceId>",
      "off <deviceId>",
      "coin <deviceId> [count]",
      "scan <deviceId> <subject>",
      "redeem <code>",
    ];
    expect([...registered.keys()]).toEqual(expected);

    await expect(registered.get("login")?.action({ session: { userId: "123456", senderName: "Tester" } })).resolves.toContain("✅ 入场成功");
    await expect(registered.get("wallet")?.action({ session: { userId: "123456" } })).resolves.toContain("100 猫粮");

    const billingResult = await registered.get("billing")?.action({ session: { userId: "123456", senderName: "Tester" } });
    expect(billingResult).toContain("计费总价：25猫粮");
    expect(billingResult).toContain("玩家ID：player-1");

    const listResult = await registered.get("list")?.action({ session: { userId: "123456" } });
    expect(listResult).toContain("窝里目前共有 1 人");
    expect(listResult).toContain("2034994588");
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
    expect(listResult).toContain("2034994588");
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

  it("registers and runs staff admin commands when enabled", async () => {
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
    const adminNames = [...registered.keys()].filter((name) => name.startsWith("admin."));
    expect(adminNames).toEqual([
      "admin.players",
      "admin.create-player <displayName>",
      "admin.grant-balance <playerId> <amount>",
      "admin.redeem-code <code> <presentId>",
      "admin.checkout <playerId>",
    ]);
    await expect(registered.get("admin.players")?.action({ session: { userId: "admin" } })).resolves.toContain("Neri");
    await expect(
      registered.get("admin.create-player <displayName>")?.action({ session: { userId: "admin" } }, "Mika"),
    ).resolves.toContain("player-new");
    await expect(
      registered.get("admin.grant-balance <playerId> <amount>")?.action({ session: { userId: "admin" } }, "player-1", "100"),
    ).resolves.toContain("发放");
    await expect(
      registered.get("admin.redeem-code <code> <presentId>")?.action({ session: { userId: "admin" } }, "PRISM-2026", "present-1"),
    ).resolves.toContain("PRISM-2026");
    await expect(
      registered.get("admin.checkout <playerId>")?.action({ session: { userId: "admin" } }, "player-1"),
    ).resolves.toContain("25");
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
});
