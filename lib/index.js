"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismBotClientError = exports.Config = exports.name = void 0;
exports.apply = apply;
exports.applyPrismKoishiPlugin = applyPrismKoishiPlugin;
exports.humanReadableBotError = humanReadableBotError;
exports.parseMahjongTables = parseMahjongTables;
const koishi_1 = require("koishi");
exports.name = "prism";
exports.Config = koishi_1.Schema.object({
    provider: koishi_1.Schema.string().required().description("平台提供商 (如 qq)"),
    autoRegister: koishi_1.Schema.boolean().default(true).description("是否自动注册"),
    baseUrl: koishi_1.Schema.string().description("PRiSM 后端 API Base URL"),
    integrationToken: koishi_1.Schema.string().role("secret").description("集成 API Token"),
    currencyName: koishi_1.Schema.string().default("猫粮").description("代币名称"),
    defaultDoorDeviceId: koishi_1.Schema.string().default("front-door").description("默认开门设备ID"),
    defaultScanProvider: koishi_1.Schema.string().default("aime").description("默认刷卡提供商"),
    loginPricingConfigIds: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description("默认入场绑定的计费策略ID"),
    loginSessionLabel: koishi_1.Schema.string().default("音游区间").description("默认入场场次标签 (防重复入场)"),
    enableStaffCommands: koishi_1.Schema.boolean().default(false).description("是否启用管理员指令"),
    staffUserIds: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description("允许执行管理员指令的平台用户ID列表"),
    logoutNotifyUserIds: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description("结账账单私聊通知的平台用户ID列表"),
    powerOffInterval: koishi_1.Schema.number().default(0).description("无人自动关机等待秒数 (0为禁用)"),
    mahjongTables: koishi_1.Schema.string().description("麻将桌配置"),
    mahjongTableSize: koishi_1.Schema.number().default(4).description("麻将桌人数限制"),
    mahjongLabelPrefix: koishi_1.Schema.string().default("麻将桌").description("麻将账单前缀"),
});
function apply(ctx, config) {
    applyPrismKoishiPlugin(ctx, config);
}
class PrismBotClientError extends Error {
    code;
    status;
    body;
    constructor(message, code, status, body) {
        super(message);
        this.code = code;
        this.status = status;
        this.body = body;
        this.name = "PrismBotClientError";
    }
}
exports.PrismBotClientError = PrismBotClientError;
const LOCAL_TZ_OFFSET_MINUTES = 8 * 60;
const USAGE = {
    mahjong_join: "/上桌 <桌号>",
    mahjong_leave: "/下桌 <桌号>",
    prism_on: "/prism on <设备ID>",
    prism_off: "/prism off <设备ID|all>",
    prism_coin: "/prism coin <设备ID> [数量]",
    prism_scan: "/prism scan <设备ID> <卡号>",
    prism_redeem: "/prism redeem <兑换码>",
    list: "/list",
    show: "/show [设备ID]",
};
function applyPrismKoishiPlugin(ctx, config) {
    const service = new PrismKoishiService(ctx, config);
    const wrap = (handler) => async (context, ...args) => {
        try {
            const message = await handler(context, ...args);
            return context.session?.messageId ? `${(0, koishi_1.h)("quote", { id: context.session.messageId })}${message}` : message;
        }
        catch (error) {
            const message = service.handleCommandError(error);
            return context.session?.messageId ? `${(0, koishi_1.h)("quote", { id: context.session.messageId })}${message}` : message;
        }
    };
    ctx.command("register", "绑定或注册当前平台用户到 PRiSM").action(wrap(async (context) => service.register(await service.sender(context))));
    ctx.command("login [target:user]", "开启玩家计费场次").action(wrap(async (context, target) => service.loginForTarget(await service.sender(context), target)));
    ctx.command("入场 [target:user]", "入场").action(wrap(async (context, target) => service.loginForTarget(await service.sender(context), target)));
    ctx.command("mahjong <tableId>", "加入指定麻将桌").action(wrap(async (context, tableId) => service.mahjongJoin(await service.sender(context), tableId)));
    ctx.command("上桌 <tableId>", "加入指定麻将桌").action(wrap(async (context, tableId) => service.mahjongJoin(await service.sender(context), tableId)));
    ctx.command("下桌 <tableId>", "离开指定麻将桌").action(wrap(async (context, tableId) => service.mahjongLeave(await service.sender(context), tableId)));
    ctx.command("logout [target:user]", "结算玩家计费场次").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.logout(sender, context.session?.bot))));
    ctx.command("billing [target:user]", "预览玩家结账费用").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.billing(sender))));
    ctx.command("wallet [target:user]", "查看玩家钱包").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.wallet(sender))));
    ctx.command("items [target:user]", "查看玩家资产").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.items(sender))));
    ctx.command("list", "查看当前在线玩家列表").action(wrap(async (context) => service.listActiveSessions(await service.sender(context))));
    ctx.command("show [deviceId]", "查看设备电源状态").action(wrap(async (context, deviceId) => service.listDeviceStates(deviceId)));
    ctx.command("history [target:user]", "查看玩家历史").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.history(sender))));
    ctx.command("lock", "向默认门锁设备发送开门指令").action(wrap(async (context) => service.lock(await service.sender(context))));
    ctx.command("on <deviceId>", "请求启动指定设备电源").action(wrap(async (context, deviceId) => service.powerOn(await service.sender(context), deviceId)));
    ctx.command("off <deviceId>", "请求关闭指定设备电源").action(wrap(async (context, deviceId) => service.powerOff(await service.sender(context), deviceId)));
    ctx.command("coin <deviceId> [count]", "请求向指定设备投币").action(wrap(async (context, deviceId, count) => service.coin(await service.sender(context), deviceId, count)));
    ctx.command("scan <deviceId> <subject>", "请求指定设备模拟刷卡").action(wrap(async (context, deviceId, subject) => service.scan(await service.sender(context), deviceId, subject)));
    ctx.command("redeem <code>", "兑换 PRiSM 礼物码").action(wrap(async (context, code) => service.redeem(await service.sender(context), code)));
    ctx.command("add <target:user> <amount:number>", "增加玩家余额").action(wrap(async (context, target, amount) => service.adjustTargetBalance(await service.sender(context), target, amount, 1)));
    ctx.command("del <target:user> <amount:number>", "扣除玩家余额").action(wrap(async (context, target, amount) => service.adjustTargetBalance(await service.sender(context), target, amount, -1)));
    ctx.command("overwrite <target:user> <amount:number> [reason:text]", "覆盖结账金额并立即结账").action(wrap(async (context, target, amount, reason) => service.overwriteTargetCheckout(await service.sender(context), target, amount, reason)));
    const intervalMs = (config.powerOffInterval ?? 0) * 1000;
    if (intervalMs > 0 && typeof ctx.setInterval === "function") {
        ctx.setInterval(() => {
            service.autoPowerOffLoop().catch(() => {
                /* swallow */
            });
        }, intervalMs);
    }
}
/* ----------------------------- api client ---------------------------------- */
class PrismApiClient {
    http;
    config;
    constructor(http, config) {
        this.http = http;
        this.config = config;
    }
    get headers() {
        return {
            "Content-Type": "application/json",
        };
    }
    async request(method, path, options) {
        let url = path;
        if (options.params) {
            for (const [key, value] of Object.entries(options.params)) {
                url = url.replace(`:${key}`, encodeURIComponent(String(value)));
            }
        }
        const fullUrl = `${this.config.baseUrl.replace(/\/+$/, "")}${url}`;
        const headers = {
            ...this.headers,
        };
        if (options.token) {
            headers["Authorization"] = `Bearer ${options.token}`;
        }
        try {
            const config = { headers, params: options.query };
            let response;
            if (method === "GET") {
                response = await this.http.get(fullUrl, config);
            }
            else if (method === "POST") {
                response = await this.http.post(fullUrl, options.body ?? {}, config);
            }
            else if (method === "PUT") {
                response = await this.http.put(fullUrl, options.body ?? {}, config);
            }
            else {
                throw new Error(`Unsupported method ${method}`);
            }
            return response;
        }
        catch (error) {
            if (error.response && error.response.data) {
                const body = error.response.data;
                const err = body.error || {};
                throw new PrismBotClientError(err.message || error.message, err.code || "API_ERROR", error.response.status || 500, body);
            }
            throw new PrismBotClientError(error.message || "Network error", "NETWORK_ERROR", 500, {});
        }
    }
    identityBody(identity) {
        return {
            identity: {
                provider: identity.provider,
                subject: identity.subject,
            },
            ...(identity.autoRegister === undefined ? {} : { autoRegister: identity.autoRegister }),
            ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
        };
    }
    async resolveOrRegisterIdentity(identity) {
        const endpoint = identity.autoRegister
            ? "/rpc/integration/players/by-identity/register"
            : "/rpc/integration/players/by-identity/resolve";
        const result = await this.request("POST", endpoint, {
            token: this.config.integrationToken,
            body: this.identityBody(identity),
        });
        return result.player;
    }
    async startSessionByIdentity(identity, body) {
        return this.request("POST", "/rpc/integration/players/by-identity/session/start", {
            token: this.config.integrationToken,
            body: {
                ...this.identityBody(identity),
                ...(body ?? {}),
            },
        });
    }
    async stopSessionByIdentity(identity, sessionId) {
        return this.request("POST", "/rpc/integration/players/by-identity/sessions/:sessionId/stop", {
            token: this.config.integrationToken,
            params: { sessionId },
            body: this.identityBody(identity),
        });
    }
    async getWalletByIdentity(identity) {
        return this.request("POST", "/rpc/integration/players/by-identity/wallet", {
            token: this.config.integrationToken,
            body: this.identityBody(identity),
        });
    }
    async getAssetsByIdentity(identity) {
        return this.request("POST", "/rpc/integration/players/by-identity/assets", {
            token: this.config.integrationToken,
            body: this.identityBody(identity),
        });
    }
    async getSessionHistoryByIdentity(identity) {
        return this.request("POST", "/rpc/integration/players/by-identity/history", {
            token: this.config.integrationToken,
            body: this.identityBody(identity),
        });
    }
    async previewCheckoutByIdentity(identity) {
        return this.request("POST", "/rpc/integration/players/by-identity/checkout/preview", {
            token: this.config.integrationToken,
            body: this.identityBody(identity),
        });
    }
    async confirmCheckoutByIdentity(identity) {
        return this.request("POST", "/rpc/integration/players/by-identity/checkout/confirm", {
            token: this.config.integrationToken,
            body: this.identityBody(identity),
        });
    }
    async redeemCodeByIdentity(identity, code) {
        return this.request("POST", "/rpc/integration/players/by-identity/redeem", {
            token: this.config.integrationToken,
            body: {
                ...this.identityBody(identity),
                code,
            },
        });
    }
    async requestDeviceCommandByIdentity(identity, command) {
        return this.request("POST", "/rpc/integration/players/by-identity/device-actions", {
            token: this.config.integrationToken,
            body: {
                ...this.identityBody(identity),
                target: command.target,
                action: {
                    type: command.type,
                    ...(command.payload === undefined ? {} : { payload: command.payload }),
                },
            },
        });
    }
    async requestScanByIdentity(identity, scan) {
        return this.request("POST", "/rpc/integration/players/by-identity/device-actions", {
            token: this.config.integrationToken,
            body: {
                ...this.identityBody(identity),
                target: {
                    kind: "game_machine",
                    id: scan.deviceId,
                },
                action: {
                    type: "aime.scan",
                    payload: {
                        provider: scan.provider,
                        subject: scan.subject,
                    },
                },
            },
        });
    }
    async listActiveSessions() {
        return this.request("GET", "/rpc/integration/sessions/active", {
            token: this.config.integrationToken,
        });
    }
    async listDeviceStates() {
        return this.request("GET", "/rpc/integration/device-states", {
            token: this.config.integrationToken,
        });
    }
    async adjustAssetsByIdentity(identity, adjustments) {
        return this.request("POST", "/rpc/integration/players/by-identity/assets/adjustments", {
            token: this.config.integrationToken,
            body: { ...this.identityBody(identity), adjustments },
        });
    }
    async checkoutWithOverrideByIdentity(identity, total, reason) {
        return this.request("POST", "/rpc/integration/players/by-identity/checkout/override", {
            token: this.config.integrationToken,
            body: { ...this.identityBody(identity), total, reason },
        });
    }
}
/* ------------------------------- service ----------------------------------- */
class PrismKoishiService {
    config;
    mahjongTables = new Map();
    client;
    constructor(ctx, config) {
        this.config = config;
        if (config.client) {
            this.client = config.client;
        }
        else {
            if (!config.baseUrl) {
                throw new Error("PRiSM Koishi plugin requires either 'client' or 'baseUrl' in config.");
            }
            if (!config.integrationToken) {
                throw new Error("PRiSM Koishi plugin requires 'integrationToken' in config when 'client' is not provided.");
            }
            const http = ctx.http ?? {
                async get(url, c) {
                    const res = await fetch(url, { method: "GET", headers: c.headers });
                    if (!res.ok)
                        throw { response: { data: await res.json(), status: res.status } };
                    return res.json();
                },
                async post(url, body, c) {
                    const res = await fetch(url, { method: "POST", headers: c.headers, body: JSON.stringify(body) });
                    if (!res.ok)
                        throw { response: { data: await res.json(), status: res.status } };
                    return res.json();
                },
                async put(url, body, c) {
                    const res = await fetch(url, { method: "PUT", headers: c.headers, body: JSON.stringify(body) });
                    if (!res.ok)
                        throw { response: { data: await res.json(), status: res.status } };
                    return res.json();
                }
            };
            this.client = new PrismApiClient(http, {
                baseUrl: config.baseUrl,
                integrationToken: config.integrationToken,
            });
        }
    }
    async sender(context) {
        const id = context.session?.senderId || context.session?.userId || "";
        let name = id;
        try {
            if (context.session?.bot?.getUser) {
                const user = await context.session.bot.getUser(id);
                if (user?.name) {
                    name = user.name;
                }
            }
        }
        catch {
            name = context.session?.username || context.session?.senderName || id;
        }
        return { id, name };
    }
    async register(sender) {
        await this.client.resolveOrRegisterIdentity(this.identity(sender));
        return "注册成功";
    }
    async loginForTarget(actor, targetSubject) {
        return this.withTarget(actor, targetSubject, async (sender, isTargeted) => {
            await this.client.startSessionByIdentity(this.identity(sender), this.loginSessionBody());
            return isTargeted ? `✅ 已为用户 ${sender.id} 入场成功` : "✅ 入场成功";
        });
    }
    async login(sender) {
        await this.client.startSessionByIdentity(this.identity(sender), this.loginSessionBody());
        return "✅ 入场成功";
    }
    async withTarget(actor, targetSubject, action) {
        const target = this.targetSender(actor, targetSubject);
        if (typeof target === "string")
            return target;
        return action(target, target !== actor);
    }
    async adjustTargetBalance(actor, targetSubject, rawAmount, direction) {
        return this.withTarget(actor, targetSubject, async (sender) => {
            const amount = Number(rawAmount);
            if (!Number.isFinite(amount) || amount <= 0)
                return "金额必须大于 0";
            const isAddition = direction === 1;
            await this.client.adjustAssetsByIdentity(this.identity(sender), [{
                    assetType: "currency",
                    assetCode: "paid",
                    quantityDelta: amount * direction,
                    reason: isAddition ? "Koishi 管理员增加余额" : "Koishi 管理员扣除余额",
                }]);
            return `✅ 已为用户 ${sender.id}${isAddition ? "增加" : "扣除"} ${formatNumber(amount)} ${this.config.currencyName}`;
        });
    }
    async overwriteTargetCheckout(actor, targetSubject, rawAmount, rawReason) {
        return this.withTarget(actor, targetSubject, async (sender) => {
            const total = Number(rawAmount);
            if (!Number.isFinite(total) || total < 0)
                return "金额必须为非负数";
            const reason = cleanText(rawReason) || "Koishi 管理员手动调价";
            await this.client.checkoutWithOverrideByIdentity(this.identity(sender), total, reason);
            return `✅ 已为用户 ${sender.id} 覆盖结账为 ${formatNumber(total)} ${this.config.currencyName}`;
        });
    }
    async mahjongJoin(sender, rawTableId) {
        const tableId = cleanText(rawTableId);
        if (!tableId)
            return commandUsage("mahjong_join");
        const tableConfig = this.mahjongTableConfigs().get(tableId);
        if (!tableConfig)
            return `找不到 ${tableId} 桌的麻将计费配置。`;
        const tableKey = tableConfig.tableId;
        const tableSubject = tableConfig.displayName || `${tableKey} 桌`;
        const player = await this.resolvePlayer(sender);
        const playerId = String(player.id ?? "");
        const activeResult = (await this.client.listActiveSessions());
        const activeSessions = (activeResult.sessions ?? []);
        if (!this.hasEntrySession(playerId, activeSessions)) {
            return "请先入场后再上桌。";
        }
        const existing = this.mahjongTableForPlayer(playerId);
        if (existing)
            return `你已经在 ${existing} 桌了。`;
        const state = this.mahjongTables.get(tableKey) ?? { waiting: [], activeSessions: {} };
        this.mahjongTables.set(tableKey, state);
        if (Object.keys(state.activeSessions).length > 0) {
            return `${tableSubject}已经开始计费，请先等当前这一桌结束。`;
        }
        state.waiting.push({
            playerId,
            senderId: sender.id,
            displayName: sender.name || playerId,
            identity: this.identity(sender),
        });
        const tableSize = this.config.mahjongTableSize ?? 4;
        if (state.waiting.length < tableSize) {
            return `已加入 ${tableSubject}，当前 ${state.waiting.length}/${tableSize} 人。`;
        }
        const seats = state.waiting.slice(0, tableSize);
        state.waiting = state.waiting.slice(tableSize);
        const label = tableConfig.displayName || `${this.config.mahjongLabelPrefix ?? "麻将桌"} ${tableKey}`;
        for (const seat of seats) {
            const result = (await this.client.startSessionByIdentity(seat.identity, {
                pricingConfigIds: tableConfig.pricingConfigIds,
                label,
            }));
            const session = (result?.session ?? {});
            const sessionId = String(session.id ?? "");
            if (sessionId)
                state.activeSessions[seat.playerId] = sessionId;
        }
        return `${tableSubject}已满，麻将计费已开始。`;
    }
    async mahjongLeave(sender, rawTableId) {
        const tableId = cleanText(rawTableId);
        if (!tableId)
            return commandUsage("mahjong_leave");
        const tableConfig = this.mahjongTableConfigs().get(tableId);
        const tableKey = tableConfig?.tableId ?? tableId;
        const tableSubject = tableConfig?.displayName || `${tableId} 桌`;
        const state = this.mahjongTables.get(tableKey);
        if (!state)
            return `你不在 ${tableSubject}。`;
        const player = await this.resolvePlayer(sender);
        const playerId = String(player.id ?? "");
        const waitingBefore = state.waiting.length;
        state.waiting = state.waiting.filter((seat) => seat.playerId !== playerId);
        if (state.waiting.length !== waitingBefore) {
            return `已离开 ${tableSubject}，当前 ${state.waiting.length}/${this.config.mahjongTableSize ?? 4} 人。`;
        }
        const sessionId = state.activeSessions[playerId];
        if (!sessionId)
            return `你不在 ${tableSubject}。`;
        delete state.activeSessions[playerId];
        await this.client.stopSessionByIdentity(this.identity(sender), sessionId);
        return `已离开 ${tableSubject}，麻将计费已停止。`;
    }
    async billing(sender) {
        const result = (await this.client.previewCheckoutByIdentity(this.identity(sender)));
        return this.formatCheckoutPreview(result, sender);
    }
    async logout(sender, bot) {
        const result = (await this.client.confirmCheckoutByIdentity(this.identity(sender)));
        const settlement = result?.playerSettlement ?? result?.settlement ?? {};
        const records = result?.settlements ?? [];
        const sessionPreviews = records.map((rec) => {
            const s = rec?.settlement ?? {};
            return {
                sessionId: s.sessionId,
                label: s.label,
                startedAt: s.startedAt,
                endedAt: s.endedAt ?? s.settledAt,
                status: "closed",
                subtotal: s.subtotal ?? 0,
                total: s.total ?? 0,
                chargeItems: rec?.chargeItems ?? [],
                adjustments: rec?.adjustments ?? [],
            };
        });
        const synthetic = {
            settlementPreview: {
                playerId: settlement.playerId,
                subtotal: settlement.subtotal ?? 0,
                total: settlement.total ?? 0,
            },
            sessionPreviews,
            chargeItems: result?.chargeItems ?? [],
            adjustments: result?.adjustments ?? [],
            assetHoldings: result?.assetHoldings ?? [],
        };
        const receipt = await this.formatCheckoutPreview(synthetic, sender, "✅ 退场成功 · 结算账单");
        const recipients = [...new Set([...(this.config.staffUserIds ?? []), ...(this.config.logoutNotifyUserIds ?? [])])];
        if (recipients.length > 0 && bot?.broadcast) {
            await bot.broadcast(recipients, receipt);
        }
        return receipt;
    }
    async wallet(sender) {
        const result = (await this.client.getWalletByIdentity(this.identity(sender)));
        return formatWallet(result, this.config.currencyName);
    }
    async items(sender) {
        const holdings = extractRows((await this.client.getAssetsByIdentity(this.identity(sender))));
        if (holdings.length === 0)
            return "您当前没有任何物品。";
        return ["🎒 --- 您拥有的物品 ---", ...holdings.map(formatInventoryItem)].join("\n");
    }
    async history(sender) {
        return formatHistory((await this.client.getSessionHistoryByIdentity(this.identity(sender))), this.config.currencyName);
    }
    async lock(sender) {
        await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
            type: "door.open",
            target: { kind: "facility", id: this.config.defaultDoorDeviceId },
        });
        return "🔑 门锁指令已发送";
    }
    async powerOn(sender, rawDeviceId) {
        const deviceId = cleanText(rawDeviceId);
        if (!deviceId)
            return commandUsage("prism_on");
        return this.power(sender, deviceId, "on");
    }
    async powerOff(sender, rawDeviceId) {
        const deviceId = cleanText(rawDeviceId);
        if (!deviceId)
            return commandUsage("prism_off");
        return this.power(sender, deviceId, "off");
    }
    async coin(sender, rawDeviceId, rawCount) {
        const deviceId = cleanText(rawDeviceId);
        if (!deviceId)
            return commandUsage("prism_coin");
        const { value, error } = parsePositiveInt(rawCount, "prism_coin", "数量", 1);
        if (error)
            return error;
        await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
            type: "coin",
            target: { kind: "game_machine", id: deviceId },
            payload: { count: value },
        });
        return `🪙 已为 ${deviceId} 投入 ${value} 个币`;
    }
    async scan(sender, rawDeviceId, rawSubject) {
        const deviceId = cleanText(rawDeviceId);
        const subject = cleanText(rawSubject);
        if (!deviceId || !subject)
            return commandUsage("prism_scan");
        await this.client.requestScanByIdentity(this.identity(sender), {
            deviceId,
            provider: this.config.defaultScanProvider || "aime",
            subject,
        });
        return `💳 使用尾号为 ${subject.slice(-4)} 的卡刷卡成功`;
    }
    async redeem(sender, rawCode) {
        const code = cleanText(rawCode);
        if (!code)
            return commandUsage("prism_redeem");
        const result = (await this.client.redeemCodeByIdentity(this.identity(sender), code));
        const holdings = extractRows(result);
        if (holdings.length === 0)
            return "兑换成功，但没有获得任何物品。";
        return ["✅ 兑换成功！您获得了以下物品：", ...holdings.map(formatRedeemedItem)].join("\n");
    }
    async listActiveSessions(sender) {
        const result = (await this.client.listActiveSessions());
        const sessions = (result?.sessions ?? []);
        const tableByLabel = new Map(uniqueMahjongConfigs(this.mahjongTableConfigs()).map((table) => [
            mahjongSessionLabel(table, this.config.mahjongLabelPrefix ?? "麻将桌"),
            table,
        ]));
        const players = groupSessionsByPlayer(sessions);
        const groups = await this.buildPlayerGroups(players, tableByLabel);
        this.mergeWaitingSeats(groups);
        return formatPlayerGroups(groups, this.config.mahjongTableSize ?? 4, this.config.mahjongLabelPrefix ?? "麻将桌");
    }
    async listDeviceStates(rawAlias) {
        const alias = cleanText(rawAlias);
        const result = (await this.client.listDeviceStates());
        const states = (result?.deviceStates ?? []);
        if (states.length === 0)
            return "没有找到任何设备状态。";
        if (alias) {
            const matched = states.find((d) => d.deviceId === alias || d.label === alias);
            if (!matched)
                return `找不到设备: ${alias}`;
            const stateVal = matched.state?.state ?? "unknown";
            return `${matched.label || matched.deviceId}: ${stateVal}`;
        }
        return states
            .map((d) => `${d.label || d.deviceId}: ${d.state?.state ?? "unknown"}`)
            .join("\n");
    }
    async autoPowerOffLoop() {
        const interval = this.config.powerOffInterval ?? 0;
        if (interval <= 0)
            return;
        const result = (await this.client.listActiveSessions());
        const sessions = (result?.sessions ?? []);
        if (sessions.length > 0)
            return;
        const statesResult = (await this.client.listDeviceStates());
        const states = (statesResult?.deviceStates ?? []);
        const anyOn = states.some((d) => d.state?.state !== "off");
        if (!anyOn)
            return;
        const dummySender = { id: "system", name: "system" };
        await this.powerOff(dummySender, "all");
    }
    /* ---------------------------- helpers ---------------------------------- */
    async power(sender, deviceId, state) {
        await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
            type: state === "on" ? "power.on" : "power.off",
            target: { kind: "facility", id: deviceId },
            payload: { state },
        });
        if (state === "on")
            return `✅ ${deviceId} 启动成功`;
        if (deviceId === "all")
            return `🛑 全部机器关闭成功`;
        return `🛑 ${deviceId} 关闭成功`;
    }
    async resolvePlatformName(subject) {
        if (!this.config.resolveDisplayName)
            return null;
        try {
            return (await this.config.resolveDisplayName(subject)) ?? null;
        }
        catch {
            return null;
        }
    }
    async displayNameForPlayer(player) {
        let identitySubject;
        for (const session of player.sessions) {
            const subject = findSubjectForSession(session, this.config.provider);
            if (!subject)
                continue;
            identitySubject ??= subject;
            const platformName = await this.resolvePlatformName(subject);
            if (platformName)
                return platformName;
        }
        return player.sessions.find((session) => session.playerDisplayName)?.playerDisplayName
            || identitySubject
            || player.displayName
            || player.playerId
            || "未知玩家";
    }
    async buildPlayerGroups(players, tableByLabel) {
        const groups = {
            music: [],
            mahjong: uniqueMahjongConfigs(this.mahjongTableConfigs()).map((table) => ({ table, players: [] })),
        };
        const groupForTable = new Map(groups.mahjong.map((group) => [group.table.tableId, group]));
        for (const player of players.values()) {
            player.displayName = await this.displayNameForPlayer(player);
            const table = player.sessions
                .map((session) => tableByLabel.get(session.label ?? ""))
                .find((value) => Boolean(value));
            if (table) {
                groupForTable.get(table.tableId)?.players.push(player);
            }
            else {
                groups.music.push(player);
            }
        }
        return groups;
    }
    mergeWaitingSeats(groups) {
        for (const [tableId, state] of this.mahjongTables) {
            const group = groups.mahjong.find((candidate) => candidate.table.tableId === tableId);
            if (!group)
                continue;
            for (const seat of state.waiting) {
                if (group.players.some((player) => player.playerId === seat.playerId))
                    continue;
                const existing = [groups.music, ...groups.mahjong.map((candidate) => candidate.players)]
                    .flat()
                    .find((player) => player.playerId === seat.playerId);
                groups.music = groups.music.filter((player) => player.playerId !== seat.playerId);
                for (const candidate of groups.mahjong) {
                    if (candidate !== group) {
                        candidate.players = candidate.players.filter((player) => player.playerId !== seat.playerId);
                    }
                }
                group.players.push(existing ?? { playerId: seat.playerId, sessions: [], displayName: seat.displayName });
            }
        }
    }
    async resolvePlayerDisplay(sender, playerId) {
        if (!sender)
            return playerId || "未知玩家";
        const platformName = await this.resolvePlatformName(sender.id);
        const name = platformName
            || (sender.name && sender.name !== sender.id ? sender.name : playerId)
            || sender.id;
        return `玩家：${name}（${this.config.provider.toUpperCase()}：${sender.id}）`;
    }
    mahjongTableForPlayer(playerId) {
        for (const [tableId, state] of this.mahjongTables) {
            if (state.activeSessions[playerId])
                return tableId;
            if (state.waiting.some((seat) => seat.playerId === playerId))
                return tableId;
        }
        return null;
    }
    mahjongTableConfigs() {
        return parseMahjongTables(this.config.mahjongTables ?? "", this.config.mahjongLabelPrefix ?? "麻将桌");
    }
    async resolvePlayer(sender) {
        return (await this.client.resolveOrRegisterIdentity(this.identity(sender)));
    }
    hasEntrySession(playerId, sessions) {
        const label = this.config.loginSessionLabel?.trim();
        return sessions.some((session) => session.playerId === playerId && (label ? session.label === label : true));
    }
    identity(sender) {
        return {
            provider: this.config.provider,
            subject: sender.id,
            autoRegister: this.config.autoRegister,
            displayName: sender.name || `${this.config.provider.toUpperCase()} ${sender.id}`,
        };
    }
    targetSender(actor, targetSubject) {
        const subject = normalizeTargetSubject(targetSubject);
        if (!subject)
            return actor;
        const denied = this.targetStaffDenied(actor);
        if (denied)
            return denied;
        return { id: subject, name: subject };
    }
    loginSessionBody() {
        const pricingConfigIds = (this.config.loginPricingConfigIds ?? [])
            .map((id) => id.trim())
            .filter(Boolean);
        const label = this.config.loginSessionLabel?.trim();
        if (pricingConfigIds.length === 0 && !label)
            return undefined;
        return {
            ...(pricingConfigIds.length === 0 ? {} : { pricingConfigIds }),
            ...(label ? { label } : {}),
        };
    }
    staffDenied(sender) {
        if (!this.config.enableStaffCommands)
            return "员工命令未启用";
        const allowed = this.config.staffUserIds ?? [];
        if (allowed.length > 0 && !allowed.includes(sender.id))
            return "权限不足";
        return null;
    }
    targetStaffDenied(sender) {
        if (!this.config.enableStaffCommands)
            return "员工命令未启用";
        const allowed = this.config.staffUserIds ?? [];
        if (!allowed.includes(sender.id))
            return "权限不足";
        return null;
    }
    async formatCheckoutPreview(result, sender, title = "【结算账单】") {
        if (result?.billing && result?.session) {
            return formatLegacyBilling(result, this.config.currencyName);
        }
        const currency = this.config.currencyName;
        const preview = result?.settlementPreview ?? result?.settlement ?? {};
        const playerId = preview?.playerId ?? "";
        const subtotal = firstDefined(preview, "subtotal", "originalCost", 0);
        const total = firstDefined(preview, "total", "finalCost", "amount", subtotal);
        const previewedAt = parseDateTime(preview?.previewedAt);
        let sessionPreviews = (result?.sessionPreviews ?? []);
        if (sessionPreviews.length === 0 && (result?.chargeItems || result?.session)) {
            const session = result?.session ?? {};
            sessionPreviews = [
                {
                    sessionId: session?.id ?? session?.sessionId,
                    label: session?.label ?? "计时区间",
                    startedAt: firstDefined(session, "startedAt", "createdAt"),
                    endedAt: firstDefined(preview, "endedAt", "settledAt", "endTime"),
                    status: session?.status ?? "active",
                    subtotal,
                    total,
                    chargeItems: result?.chargeItems ?? [],
                    adjustments: [],
                },
            ];
        }
        const adjustments = result?.adjustments ?? [];
        const assetHoldings = result?.assetHoldings ?? [];
        const lines = [];
        lines.push(title);
        lines.push(await this.resolvePlayerDisplay(sender, playerId));
        let balance = 0;
        let hasBalance = false;
        for (const holding of assetHoldings) {
            const code = String(holding?.assetCode ?? "").toLowerCase();
            if (code.includes("paid") || code.includes("free") || code.includes("currency")) {
                balance += toNumber(holding?.quantity ?? 0);
                hasBalance = true;
            }
        }
        const hasNonZeroSessionTotal = sessionPreviews.some((session) => toNumber(session?.total ?? 0) !== 0);
        const hasNonZeroAdjustment = hasAdjustmentEntries(adjustments, sessionPreviews);
        if (!hasNonZeroSessionTotal && !hasNonZeroAdjustment) {
            lines.push("");
            lines.push("本次未产生费用");
            if (hasBalance)
                lines.push(`余额：${formatNumber(balance)}${currency}`);
            return lines.join("\n");
        }
        const validStarts = sessionPreviews.map((s) => parseDateTime(s?.startedAt)).filter(Boolean);
        const validEnds = sessionPreviews.map((s) => sessionDisplayEnd(s, previewedAt)).filter(Boolean);
        if (validStarts.length > 0) {
            const overallStart = minDate(validStarts);
            const overallEnd = validEnds.length > 0 ? maxDate(validEnds) : now(this.config);
            lines.push(`⏰ 游玩时间：${formatHM(overallStart)}–${formatHM(overallEnd)}`);
        }
        for (const sPrev of sessionPreviews) {
            const label = sPrev?.label || "计时区间";
            const startDt = parseDateTime(sPrev?.startedAt);
            const endDt = sessionDisplayEnd(sPrev, previewedAt);
            const status = sPrev?.status ?? "active";
            const sTotal = toNumber(sPrev?.total ?? 0);
            lines.push("");
            lines.push(label);
            if (startDt && endDt) {
                const minutes = Math.floor((endDt.getTime() - startDt.getTime()) / 60_000);
                lines.push(`游玩时段：${formatHM(startDt)}-${formatHM(endDt)}`);
                lines.push(`游玩时长：${formatDurationValue(minutes)}｜消费：${formatNumber(sTotal)}${currency}`);
            }
            else if (startDt) {
                lines.push(`入场：${formatHM(startDt)}  （${status === "active" ? "计费中" : "已关闭"}）`);
            }
            const sessionAdjustments = (sPrev?.adjustments ?? []);
            for (const adj of sessionAdjustments) {
                const amount = toNumber(firstDefined(adj ?? {}, "amount", "saved", 0));
                if (amount === 0)
                    continue;
                const adjLabel = firstDefined(adj ?? {}, "label", "name", "source") ?? "优惠";
                lines.push(`  └ ${adjLabel}：${formatNumber(amount)}${currency}`);
            }
        }
        lines.push("");
        lines.push(`计费总价：${formatNumber(subtotal)}${currency}`);
        if (hasNonZeroAdjustment)
            lines.push(`优惠后价格：${formatNumber(total)}${currency}`);
        if (hasBalance)
            lines.push(`扣款后余额：${formatNumber(balance)}${currency}`);
        return lines.join("\n");
    }
    handleCommandError(error) {
        if (error instanceof PrismBotClientError) {
            return humanReadableBotError(error);
        }
        if (error instanceof Error) {
            return `操作失败: ${error.message}`;
        }
        return "操作失败";
    }
}
function humanReadableBotError(error) {
    if (error.code === "DUPLICATE_SESSION_LABEL") {
        return "❌ 您已经处于入场状态，请勿重复发送入场命令。";
    }
    if (error.code === "PLAYER_HAS_NO_UNSETTLED_SESSIONS") {
        return "您当前没有未结算的账单，无需结账。";
    }
    if (error.code === "ACTIVE_SESSION_NOT_FOUND") {
        return "您当前没有进行中的计费场次。";
    }
    if (error.code === "PLAYER_IDENTITY_NOT_FOUND") {
        return "未找到您的玩家身份，请先注册或绑定账号。";
    }
    if (error.code === "INSUFFICIENT_BALANCE") {
        return "余额不足，暂时不能结账。请先充值，或由店员在后台改价后再结账。";
    }
    if (error.code === "API_UNREACHABLE" || error.code === "HTTP_0") {
        return "连接不到 PRiSM 后端，请确认后端服务正在运行。";
    }
    if (error.code === "API_TIMEOUT") {
        return "PRiSM 后端响应超时，请稍后再试。";
    }
    if (error.code === "INVALID_JSON_RESPONSE") {
        return "PRiSM 后端返回了非 JSON 响应，请检查后端是否正常运行。";
    }
    if (error.code === "STAFF_TOKEN_REQUIRED") {
        return "缺少管理面板令牌。";
    }
    return String(error?.message ?? error);
}
function parseMahjongTables(value, labelPrefix) {
    const tables = new Map();
    for (const item of value.replace(/\n/g, ";").split(";")) {
        const text = item.trim();
        if (!text)
            continue;
        let aliasPart;
        let rest;
        let displayName = "";
        if (text.includes(":")) {
            [aliasPart, rest] = splitOnce(text, ":");
            if (!rest.includes("="))
                continue;
            [displayName, rest] = splitOnce(rest, "=");
            displayName = displayName.trim();
        }
        else {
            if (!text.includes("="))
                continue;
            [aliasPart, rest] = splitOnce(text, "=");
        }
        const aliases = aliasPart.split(",").map((a) => a.trim()).filter(Boolean);
        const pricingConfigIds = rest.split("+").map((p) => p.trim()).filter(Boolean);
        if (aliases.length === 0 || pricingConfigIds.length === 0)
            continue;
        const tableId = aliases[0];
        const config = {
            tableId,
            displayName,
            aliases,
            pricingConfigIds,
        };
        for (const alias of aliases)
            tables.set(alias, config);
    }
    return tables;
}
function uniqueMahjongConfigs(tables) {
    return [...new Map([...tables.values()].map((table) => [table.tableId, table])).values()];
}
function mahjongSessionLabel(table, labelPrefix) {
    return table.displayName || `${labelPrefix} ${table.tableId}`;
}
function groupSessionsByPlayer(sessions) {
    const players = new Map();
    for (const session of sessions) {
        const playerId = session.playerId || findSubjectForSession(session, "") || "";
        if (!playerId)
            continue;
        const player = players.get(playerId) ?? { playerId, sessions: [] };
        player.sessions.push(session);
        players.set(playerId, player);
    }
    return players;
}
function formatPlayerGroups(groups, tableSize, mahjongLabelPrefix) {
    const populatedMahjongGroups = groups.mahjong.filter((group) => group.players.length > 0);
    const total = groups.music.length + populatedMahjongGroups.reduce((sum, group) => sum + group.players.length, 0);
    if (total === 0)
        return "🫥 窝里目前没有玩家呢";
    const lines = [`[总计 ${total} 人]`];
    if (groups.music.length > 0) {
        lines.push(`🎵 音乐游戏 ( ${groups.music.length}人 )：\n${formatPlayerNames(groups.music)}`);
    }
    for (const group of populatedMahjongGroups) {
        lines.push(`${formatMahjongTableLabel(group.table, mahjongLabelPrefix)} ( ${group.players.length}/${tableSize} )：\n${formatPlayerNames(group.players)}`);
    }
    return lines.join("\n");
}
function formatMahjongTableLabel(table, labelPrefix) {
    const label = mahjongSessionLabel(table, labelPrefix);
    return table.displayName ? label : `🀄️ ${label}`;
}
function formatPlayerNames(players) {
    return players.map((player) => `- ${player.displayName || player.playerId || "未知玩家"}`).join(", ");
}
function splitOnce(text, sep) {
    const idx = text.indexOf(sep);
    if (idx === -1)
        return [text, ""];
    return [text.slice(0, idx), text.slice(idx + sep.length)];
}
function commandUsage(command) {
    return `用法: ${USAGE[command] ?? command}`;
}
function parsePositiveInt(value, command, label, fallback) {
    const text = cleanText(value);
    if (!text) {
        if (fallback !== undefined)
            return { value: fallback, error: null };
        return { value: 0, error: commandUsage(command) };
    }
    const parsed = Number.parseInt(text, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return { value: 0, error: `${label}必须是正整数\n${commandUsage(command)}` };
    }
    return { value: parsed, error: null };
}
function cleanText(value) {
    return value == null ? "" : String(value).trim();
}
function normalizeTargetSubject(value) {
    const subject = cleanText(value);
    const separator = subject.indexOf(":");
    return separator > 0 ? subject.slice(separator + 1) : subject;
}
function toNumber(value) {
    if (value == null)
        return 0;
    if (typeof value === "boolean")
        return value ? 1 : 0;
    if (typeof value === "number")
        return value;
    const text = String(value).trim();
    if (!text)
        return 0;
    const asInt = Number.parseInt(text, 10);
    if (!Number.isNaN(asInt))
        return asInt;
    const asFloat = Number.parseFloat(text);
    if (!Number.isNaN(asFloat))
        return asFloat;
    return 0;
}
function hasAdjustmentEntries(adjustments, sessionPreviews) {
    return adjustments.some((adjustment) => toNumber(firstDefined(adjustment ?? {}, "amount", "saved", 0)) !== 0) || sessionPreviews.some((session) => (session?.adjustments ?? []).some((adjustment) => toNumber(firstDefined(adjustment ?? {}, "amount", "saved", 0)) !== 0));
}
function formatNumber(value) {
    if (typeof value === "boolean")
        return value ? "1" : "0";
    if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : String(value);
    }
    const num = toNumber(value);
    if (num || String(value ?? "").trim() === "0" || String(value ?? "").trim() === "0.0") {
        return Number.isInteger(num) ? String(num) : String(num);
    }
    return String(value);
}
function parseDateTime(value) {
    if (!value)
        return null;
    if (value instanceof Date) {
        return ensureLocal(value);
    }
    const text = String(value).trim();
    if (!text)
        return null;
    let normalized = text;
    if (normalized.endsWith("Z"))
        normalized = `${normalized.slice(0, -1)}+00:00`;
    const dt = new Date(normalized);
    if (!Number.isNaN(dt.getTime()))
        return ensureLocal(dt);
    return null;
}
function ensureLocal(dt) {
    const offsetMs = LOCAL_TZ_OFFSET_MINUTES * 60_000;
    const local = new Date(dt.getTime() + offsetMs);
    void local;
    return dt;
}
function formatHM(dt) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}
function formatDateTime(value) {
    const dt = parseDateTime(value);
    if (!dt)
        return "永不过期";
    const pad = (n) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}/${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}
function formatTimeRange(start, end) {
    const startDt = parseDateTime(start);
    const endDt = parseDateTime(end);
    if (!startDt || !endDt)
        return `${formatDateTime(start)} - ${formatDateTime(end)}`;
    const pad = (n) => String(n).padStart(2, "0");
    const startTime = `${pad(startDt.getHours())}:${pad(startDt.getMinutes())}:${pad(startDt.getSeconds())}`;
    const endTime = `${pad(endDt.getHours())}:${pad(endDt.getMinutes())}:${pad(endDt.getSeconds())}`;
    if (startDt.toDateString() === endDt.toDateString())
        return `${startTime} - ${endTime}`;
    return `${startDt.getMonth() + 1}/${startDt.getDate()} ${startTime} - ${endDt.getMonth() + 1}/${endDt.getDate()} ${endTime}`;
}
function formatDurationMinutes(start, end) {
    const startDt = parseDateTime(start);
    const endDt = parseDateTime(end);
    if (!startDt || !endDt)
        return "0分钟";
    return formatDurationValue(Math.floor((endDt.getTime() - startDt.getTime()) / 60_000));
}
function formatDurationValue(minutes) {
    const total = Math.floor(toNumber(minutes));
    if (total >= 60) {
        const hours = Math.floor(total / 60);
        const mins = total % 60;
        return `${hours}小时${mins}分钟`;
    }
    return `${total}分钟`;
}
function sessionDisplayEnd(session, previewedAt) {
    const endedAt = parseDateTime(session?.endedAt);
    if (endedAt)
        return endedAt;
    if (session?.status === "active")
        return previewedAt ?? now(undefined);
    return null;
}
function now(config) {
    return config?.now ? config.now() : new Date();
}
function minDate(dates) {
    return dates.reduce((acc, d) => (d.getTime() < acc.getTime() ? d : acc), dates[0]);
}
function maxDate(dates) {
    return dates.reduce((acc, d) => (d.getTime() > acc.getTime() ? d : acc), dates[0]);
}
function extractRows(value) {
    if (Array.isArray(value))
        return value.filter((row) => row && typeof row === "object");
    if (!value || typeof value !== "object")
        return [];
    for (const key of ["holdings", "assets", "items", "wallet", "sessions"]) {
        const rows = value[key];
        if (Array.isArray(rows))
            return rows.filter((row) => row && typeof row === "object");
    }
    return [];
}
function rowQuantity(row) {
    return toNumber(firstDefined(row, "quantity", "amount", "count", 0));
}
function holdingName(row) {
    return (row.name ||
        row.assetName ||
        assetName(row) ||
        row.assetCode ||
        row.type ||
        "资产");
}
function assetName(row) {
    const asset = row?.asset;
    if (asset && typeof asset === "object") {
        return asset.name || asset.code || "";
    }
    return row.assetName || row.name || row.assetCode || "资产";
}
function isPaidBalance(row) {
    const value = `${row?.assetCode ?? ""} ${row?.assetName ?? ""} ${row?.type ?? ""}`.toLowerCase();
    return value.includes("paid") || value.includes("充值");
}
function isFreeBalance(row) {
    const value = `${row?.assetCode ?? ""} ${row?.assetName ?? ""} ${row?.type ?? ""}`.toLowerCase();
    return value.includes("free") || value.includes("免费") || value.includes("赠送");
}
function firstDefined(mapping, ...keys) {
    const last = keys[keys.length - 1];
    let keyList = keys;
    let fallback = undefined;
    if (typeof last !== "string") {
        fallback = last;
        keyList = keys.slice(0, -1);
    }
    for (const key of keyList) {
        if (mapping && typeof mapping === "object" && key in mapping && mapping[key] != null)
            return mapping[key];
    }
    return fallback;
}
function formatInventoryItem(row) {
    let line = `- ${holdingName(row)} (x${formatNumber(rowQuantity(row))})`;
    const expiresAt = row?.expireAt ?? row?.expiresAt;
    if (expiresAt)
        line += `\n  到期: ${formatDateTime(expiresAt)}`;
    return line;
}
function formatRedeemedItem(row) {
    let name = holdingName(row);
    const assetType = row?.assetType ?? row?.asset?.type;
    const durationMs = row?.durationMs;
    if (assetType === "PASS" && durationMs) {
        const days = Math.floor(toNumber(durationMs) / (1000 * 60 * 60 * 24));
        if (days > 0)
            name += ` (${days}天)`;
    }
    return `- ${name} x${formatNumber(rowQuantity(row))}`;
}
function formatWallet(result, currency) {
    if (result && typeof result.total === "object") {
        return formatLegacyWallet(result, currency);
    }
    const rows = extractRows(result?.wallet ?? result);
    const paid = rows.filter(isPaidBalance).reduce((acc, row) => acc + rowQuantity(row), 0);
    const free = rows.filter(isFreeBalance).reduce((acc, row) => acc + rowQuantity(row), 0);
    const other = rows
        .filter((row) => !isPaidBalance(row) && !isFreeBalance(row))
        .reduce((acc, row) => acc + rowQuantity(row), 0);
    const total = paid + free + other;
    return [
        "💰 --- 钱包余额 ---",
        `可用: ${formatNumber(total)} ${currency} (共 ${formatNumber(total)})`,
        `  - 付费: ${formatNumber(paid)}`,
        `  - 免费: ${formatNumber(free)}`,
    ].join("\n");
}
function formatLegacyWallet(result, currency) {
    const totalInfo = result?.total ?? {};
    const paidInfo = result?.paid ?? {};
    const freeInfo = result?.free ?? {};
    const available = firstDefined(totalInfo, "available", 0);
    const allBalance = firstDefined(totalInfo, "all", available);
    const paid = firstDefined(paidInfo, "available", 0);
    const free = firstDefined(freeInfo, "available", 0);
    const lines = [
        "💰 --- 钱包余额 ---",
        `可用: ${formatNumber(available)} ${currency} (共 ${formatNumber(allBalance)})`,
        `  - 付费: ${formatNumber(paid)}`,
        `  - 免费: ${formatNumber(free)}`,
    ];
    const unavailable = toNumber(allBalance) - toNumber(available);
    if (unavailable > 0) {
        lines.push(`\n您还有 ${formatNumber(unavailable)} ${currency}未到可用时间。`);
    }
    const expiringFree = availableDetails(freeInfo).filter((item) => item.expireAt);
    expiringFree.sort((a, b) => (parseDateTime(a.expireAt)?.getTime() ?? 0) - (parseDateTime(b.expireAt)?.getTime() ?? 0));
    if (expiringFree.length > 0) {
        const soonest = expiringFree[0];
        lines.push(`\n注意：您有 ${formatNumber(soonest.count ?? 0)} 免费${currency}将于 ${formatDateTime(soonest.expireAt)} 过期。`);
    }
    const passes = availableDetails(result?.passes);
    if (passes.length > 0) {
        lines.push(`\n--- 可用月卡 (${passes.length}) ---`);
        for (const item of passes) {
            lines.push(`- ${assetName(item)}`);
            lines.push(`  到期: ${formatDateTime(item?.expireAt ?? item?.expiresAt)}`);
        }
    }
    const tickets = availableDetails(result?.tickets);
    if (tickets.length > 0) {
        lines.push(`\n--- 可用优惠券 (${tickets.length}) ---`);
        for (const item of tickets) {
            lines.push(`- ${assetName(item)} (x${formatNumber(item?.count ?? rowQuantity(item))})`);
            lines.push(`  到期: ${formatDateTime(item?.expireAt ?? item?.expiresAt)}`);
        }
    }
    return lines.join("\n");
}
function availableDetails(value) {
    const details = value?.details ?? {};
    const rows = details?.available ?? [];
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
}
function formatHistory(result, currency) {
    const sessions = extractRows(result?.sessions ?? result);
    if (sessions.length === 0)
        return "暂无历史记录";
    const lines = [`📜 最近 ${sessions.length} 条记录:`];
    for (const session of sessions) {
        const sessionId = firstDefined(session, "id", "sessionId", "");
        const start = formatDateTime(firstDefined(session, "createdAt", "startedAt", "startTime"));
        const endRaw = firstDefined(session, "closedAt", "endedAt", "endTime");
        const end = endRaw ? formatDateTime(endRaw) : "进行中";
        const finalCost = firstDefined(session, "finalCost", "total");
        const cost = finalCost == null ? "未结算" : `${formatNumber(finalCost)} ${currency}`;
        lines.push(`- [${sessionId}] ${start} -> ${end} (${cost})`);
    }
    return lines.join("\n");
}
function formatLegacyBilling(result, currency) {
    const billing = result?.billing ?? {};
    const session = result?.session ?? {};
    const discount = result?.discount;
    const wallet = result?.wallet ?? {};
    const lines = ["--- 账单详情 ---"];
    const start = session.createdAt;
    const end = billing.endTime;
    lines.push(`入场: ${formatDateTime(start)}`);
    lines.push(`结算: ${formatDateTime(end)}`);
    lines.push(`时长: ${formatDurationMinutes(start, end)}`);
    lines.push("---");
    const originalCost = discount ? discount.originalCost : billing.totalCost ?? 0;
    let finalCost = discount ? discount.finalCost : billing.totalCost ?? 0;
    if (session.costOverwrite)
        finalCost = session.costOverwrite;
    lines.push(`计费价: ${formatNumber(originalCost)} ${currency}`);
    if (discount) {
        for (const log of discount.appliedLogs ?? []) {
            lines.push(`  -「${log?.asset ?? ""}」: -${formatNumber(log?.saved ?? 0)} ${currency}`);
        }
    }
    lines.push(`结算价: ${formatNumber(finalCost)} ${currency}`);
    const walletTotal = wallet?.total ?? {};
    if (walletTotal.available != null) {
        const currentBalance = walletTotal.available ?? 0;
        lines.push("---");
        lines.push(`当前余额: ${formatNumber(currentBalance)} ${currency}`);
        lines.push(`扣款后: ${formatNumber(toNumber(currentBalance) - toNumber(finalCost))} ${currency}`);
    }
    lines.push("---");
    lines.push("计费区间:");
    const segments = billing.segments ?? [];
    if (segments.length === 0) {
        lines.push("  (无)");
    }
    for (const segment of segments) {
        if (toNumber(segment?.cost ?? 0) < 0)
            continue;
        lines.push(`- ${segment?.ruleName ?? ""}`);
        if (segment?.startTime && segment?.endTime) {
            lines.push(`  时段: ${formatTimeRange(segment.startTime, segment.endTime)}`);
        }
        lines.push(`  时长: ${formatDurationValue(segment?.durationMinutes ?? 0)}`);
        const capped = segment?.isCapped ? " (已封顶)" : "";
        lines.push(`  费用: ${formatNumber(segment?.cost ?? 0)} ${currency}${capped}`.trim());
    }
    const monthlyPass = (wallet?.passes?.details?.available ?? [null])[0];
    if (monthlyPass && monthlyPass?.expireAt) {
        lines.push("---");
        lines.push(`您的月卡将于 ${formatDateTime(monthlyPass.expireAt)} 到期。`);
    }
    return lines.join("\n");
}
function findSubjectForSession(session, provider) {
    const identities = session.identities ?? [];
    if (identities.length === 0)
        return null;
    const qq = identities.find((id) => id.provider === provider);
    if (qq)
        return qq.subject;
    return identities[0].subject ?? null;
}
exports.default = {
    name: exports.name,
    Config: exports.Config,
    ConfigSchema: exports.Config,
    apply,
};
