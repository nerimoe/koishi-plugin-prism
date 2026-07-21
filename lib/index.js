"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismBotClientError = exports.Config = exports.version = exports.name = void 0;
exports.apply = apply;
exports.applyPrismKoishiPlugin = applyPrismKoishiPlugin;
exports.humanReadableBotError = humanReadableBotError;
exports.resolveMahjongTableConfigs = resolveMahjongTableConfigs;
const koishi_1 = require("koishi");
const package_json_1 = __importDefault(require("../package.json"));
exports.name = "prism";
exports.version = package_json_1.default.version;
exports.Config = koishi_1.Schema.object({
    provider: koishi_1.Schema.string().required().description("平台提供商 (如 qq)"),
    autoRegister: koishi_1.Schema.boolean().default(true).description("是否自动注册"),
    baseUrl: koishi_1.Schema.string().description("PRiSM 后端 API Base URL"),
    integrationToken: koishi_1.Schema.string().role("secret").description("集成 API Token"),
    currencyName: koishi_1.Schema.string().default("猫粮").description("代币名称"),
    defaultDoorDeviceId: koishi_1.Schema.string().default("front-door").description("默认开门设备名或别名"),
    defaultScanProvider: koishi_1.Schema.string().default("aime").description("默认刷卡提供商"),
    loginPricingConfigIds: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description("默认入场绑定的计费策略ID"),
    loginSessionLabel: koishi_1.Schema.string().default("音游区间").description("默认入场场次标签 (防重复入场)"),
    enableStaffCommands: koishi_1.Schema.boolean().default(false).description("是否启用管理员指令"),
    staffUserIds: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description("允许执行管理员指令的平台用户ID列表"),
    logoutNotifyUserIds: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description("结账账单私聊通知的平台用户ID列表"),
    powerOffInterval: koishi_1.Schema.number().default(0).description("无人自动关机等待秒数 (0为禁用)"),
    mahjongTableConfigs: koishi_1.Schema.array(koishi_1.Schema.object({
        displayName: koishi_1.Schema.string().required().description("桌位显示名称和 session 标签"),
        aliases: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description("命令别名（至少一个），例如 a、四麻A"),
        pricingConfigIds: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description("开局时绑定的计费方案 ID"),
    })).default([]).description("麻将桌配置"),
    mahjongTableSize: koishi_1.Schema.number().default(4).description("麻将桌人数限制"),
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
    mahjong_leave: "/下桌",
    mahjong_list: "/麻将列表",
    api_benchmark: "/api测速 [次数]",
    prism_on: "/prism on <设备名|别名|all>",
    prism_off: "/prism off <设备名|别名|all>",
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
    ctx.command("login [target:user]", "开启玩家计费场次").action(wrap(async (context, target) => service.loginForTarget(await service.sender(context), target, context.session?.bot)));
    ctx.command("入场 [target:user]", "入场").action(wrap(async (context, target) => service.loginForTarget(await service.sender(context), target, context.session?.bot)));
    ctx.command("mahjong <tableId>", "加入指定麻将桌").action(wrap(async (context, tableId) => service.mahjongJoin(await service.sender(context), tableId)));
    ctx.command("上桌 [tableId]", "加入指定麻将桌").action(wrap(async (context, tableId) => service.mahjongJoin(await service.sender(context), tableId)));
    ctx.command("下桌", "离开当前所在麻将桌").action(wrap(async (context) => service.mahjongLeave(await service.sender(context))));
    ctx.command("麻将列表", "查看麻将机状态与别名").action(wrap(async () => service.listMahjongTables()));
    ctx.command("logout [target:user]", "结算玩家计费场次").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.logout(sender, context.session?.bot), context.session?.bot)));
    ctx.command("billing [target:user]", "预览玩家结账费用").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.billing(sender), context.session?.bot)));
    ctx.command("wallet [target:user]", "查看玩家钱包").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.wallet(sender), context.session?.bot)));
    ctx.command("api测速 [count:number]", "测试 Bot 到 PRiSM API 的钱包查询延迟").action(wrap(async (context, count) => service.benchmarkApi(await service.sender(context), count)));
    ctx.command("versions", "查看 Bot 与 PRiSM 后端版本").action(wrap(async () => service.versions()));
    ctx.command("items [target:user]", "查看玩家资产").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.items(sender), context.session?.bot)));
    ctx.command("list", "查看当前在线玩家列表").action(wrap(async (context) => service.listActiveSessions(await service.sender(context))));
    ctx.command("show [deviceId]", "查看设备电源状态").action(wrap(async (context, deviceId) => service.listDeviceStates(deviceId)));
    ctx.command("history [target:user]", "查看玩家历史").action(wrap(async (context, target) => service.withTarget(await service.sender(context), target, (sender) => service.history(sender), context.session?.bot)));
    ctx.command("lock", "向默认门锁设备发送开门指令").action(wrap(async (context) => service.lock(await service.sender(context))));
    ctx.command("on <deviceRef>", "请求启动指定设备电源").action(wrap(async (context, deviceRef) => service.powerOn(await service.sender(context), deviceRef)));
    ctx.command("off <deviceRef>", "请求关闭指定设备电源").action(wrap(async (context, deviceRef) => service.powerOff(await service.sender(context), deviceRef)));
    ctx.command("coin <deviceId> [count]", "请求向指定设备投币").action(wrap(async (context, deviceId, count) => service.coin(await service.sender(context), deviceId, count)));
    ctx.command("scan <deviceId> <subject>", "请求指定设备模拟刷卡").action(wrap(async (context, deviceId, subject) => service.scan(await service.sender(context), deviceId, subject)));
    ctx.command("redeem <code>", "兑换 PRiSM 礼物码").action(wrap(async (context, code) => service.redeem(await service.sender(context), code)));
    ctx.command("add <target:user> <amount:number>", "增加玩家余额").action(wrap(async (context, target, amount) => service.adjustTargetBalance(await service.sender(context), target, amount, 1, context.session?.bot)));
    ctx.command("del <target:user> <amount:number>", "扣除玩家余额").action(wrap(async (context, target, amount) => service.adjustTargetBalance(await service.sender(context), target, amount, -1, context.session?.bot)));
    ctx.command("overwrite <target:user> <amount:number> [reason:text]", "覆盖结账金额并立即结账").action(wrap(async (context, target, amount, reason) => service.overwriteTargetCheckout(await service.sender(context), target, amount, reason, context.session?.bot)));
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
    async getVersion() {
        return this.request("GET", "/version", {});
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
    async confirmCheckoutByIdentity(identity, closeSessionsBeforeBalanceCheck = true) {
        return this.request("POST", "/rpc/integration/players/by-identity/checkout/confirm", {
            token: this.config.integrationToken,
            body: { ...this.identityBody(identity), closeSessionsBeforeBalanceCheck },
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
    async adjustWalletByIdentity(identity, amount, reason) {
        return this.request("POST", "/rpc/integration/players/by-identity/wallet/adjustment", {
            token: this.config.integrationToken,
            body: { ...this.identityBody(identity), amount, reason },
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
    logoutInFlight = new Map();
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
        let name = context.session?.username || context.session?.senderName || id;
        try {
            if (context.session?.bot?.getUser) {
                const user = await context.session.bot.getUser(id);
                if (user?.name) {
                    name = user.name;
                }
            }
        }
        catch { }
        return { id, name };
    }
    async register(sender) {
        await this.client.resolveOrRegisterIdentity(this.identity(sender));
        return "注册成功";
    }
    async loginForTarget(actor, targetSubject, bot) {
        return this.withTarget(actor, targetSubject, async (sender, isTargeted) => {
            await this.client.startSessionByIdentity(this.identity(sender), this.loginSessionBody());
            return isTargeted ? `✅ 已为用户 ${formatPlayerReference(sender, this.config.provider)} 入场成功` : "✅ 入场成功";
        }, bot);
    }
    async login(sender) {
        await this.client.startSessionByIdentity(this.identity(sender), this.loginSessionBody());
        return "✅ 入场成功";
    }
    async withTarget(actor, targetSubject, action, bot) {
        const target = await this.targetSender(actor, targetSubject, bot);
        if (typeof target === "string")
            return target;
        return action(target, target !== actor);
    }
    async adjustTargetBalance(actor, targetSubject, rawAmount, direction, bot) {
        return this.withTarget(actor, targetSubject, async (sender) => {
            const amount = Number(rawAmount);
            if (!Number.isFinite(amount) || amount <= 0)
                return "金额必须大于 0";
            const isAddition = direction === 1;
            await this.client.adjustWalletByIdentity(this.identity(sender), amount * direction, isAddition ? "Koishi 管理员增加余额" : "Koishi 管理员扣除余额");
            return `✅ 已为用户 ${formatPlayerReference(sender, this.config.provider)}${isAddition ? "增加" : "扣除"} ${formatNumber(amount)} ${this.config.currencyName}`;
        }, bot);
    }
    async overwriteTargetCheckout(actor, targetSubject, rawAmount, rawReason, bot) {
        return this.withTarget(actor, targetSubject, async (sender) => {
            const total = Number(rawAmount);
            if (!Number.isFinite(total) || total < 0)
                return "金额必须为非负数";
            const reason = cleanText(rawReason) || "管理员调价";
            const result = (await this.client.checkoutWithOverrideByIdentity(this.identity(sender), total, reason));
            const playerId = String(result.playerSettlement.playerId);
            if (playerId)
                this.removeMahjongPlayer(playerId);
            return this.formatAndNotifyCheckout(result, sender, "✅ 覆盖结账成功 · 结算账单", bot);
        }, bot);
    }
    async mahjongJoin(sender, rawTableId) {
        const tableId = cleanText(rawTableId);
        if (!tableId)
            return "请指定麻将桌，例如 /上桌 a；可先使用 /麻将列表 查看可用桌位。";
        const tableConfig = this.mahjongTableConfigs().get(tableId);
        if (!tableConfig)
            return `未找到麻将桌「${tableId}」。可先使用 /麻将列表 查看可用桌位。`;
        const tableKey = tableConfig.tableId;
        const tableSubject = tableConfig.displayName || `${tableKey} 桌`;
        const player = await this.resolvePlayer(sender);
        const playerId = String(player.id ?? "");
        const activeResult = (await this.client.listActiveSessions());
        const activeSessions = (activeResult.sessions ?? []);
        this.syncMahjongTableStates(activeSessions);
        if (!this.hasEntrySession(playerId, activeSessions)) {
            return "请先入场后再上桌。";
        }
        const existing = this.mahjongTableForPlayer(playerId);
        if (existing)
            return `你已经在 ${existing}，无需重复上桌。`;
        const state = this.mahjongTables.get(tableKey) ?? { waiting: [], activeSessions: {} };
        this.mahjongTables.set(tableKey, state);
        const activeCount = Object.keys(state.activeSessions).length;
        const tableSize = this.config.mahjongTableSize ?? 4;
        if (activeCount >= tableSize) {
            return `「${tableSubject}」正在游玩中（${activeCount}/${tableSize}），请等待本局结束后再上桌。`;
        }
        if (activeCount > 0) {
            const label = tableConfig.displayName;
            const result = (await this.client.startSessionByIdentity(this.identity(sender), {
                pricingConfigIds: tableConfig.pricingConfigIds,
                label,
            }));
            const session = (result?.session ?? {});
            const sessionId = String(session.id ?? "");
            if (sessionId) {
                state.activeSessions[playerId] = sessionId;
            }
            return `已加入 ${tableSubject}，补位成功，麻将计费已开始。当前 ${activeCount + 1}/${tableSize} 人。`;
        }
        state.waiting.push({
            playerId,
            senderId: sender.id,
            displayName: sender.name || playerId,
            identity: this.identity(sender),
        });
        if (state.waiting.length < tableSize) {
            return `已加入 ${tableSubject}，当前 ${state.waiting.length}/${tableSize} 人。`;
        }
        const seats = state.waiting.slice(0, tableSize);
        state.waiting = state.waiting.slice(tableSize);
        const label = tableConfig.displayName;
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
    async mahjongLeave(sender) {
        const activeResult = (await this.client.listActiveSessions());
        this.syncMahjongTableStates((activeResult.sessions ?? []));
        const player = await this.resolvePlayer(sender);
        const playerId = String(player.id ?? "");
        const tableKey = this.mahjongTableForPlayer(playerId);
        if (!tableKey)
            return "你当前未在任何麻将桌上。";
        const tableConfig = uniqueMahjongConfigs(this.mahjongTableConfigs()).find((table) => table.tableId === tableKey);
        const tableSubject = tableConfig?.displayName || tableKey;
        const state = this.mahjongTables.get(tableKey);
        if (!state)
            return "你当前未在任何麻将桌上。";
        const waitingBefore = state.waiting.length;
        state.waiting = state.waiting.filter((seat) => seat.playerId !== playerId);
        if (state.waiting.length !== waitingBefore) {
            return `已离开 ${tableSubject}，当前 ${state.waiting.length}/${this.config.mahjongTableSize ?? 4} 人。`;
        }
        const sessionId = state.activeSessions[playerId];
        if (!sessionId)
            return "你当前未在任何麻将桌上。";
        delete state.activeSessions[playerId];
        const remainingCount = Object.keys(state.activeSessions).length;
        const tableSize = this.config.mahjongTableSize ?? 4;
        await this.client.stopSessionByIdentity(this.identity(sender), sessionId);
        return `已离开 ${tableSubject}，麻将计费已停止。当前还剩 ${remainingCount}/${tableSize} 人。`;
    }
    async listMahjongTables() {
        const activeResult = (await this.client.listActiveSessions());
        this.syncMahjongTableStates((activeResult.sessions ?? []));
        const tableSize = this.config.mahjongTableSize ?? 4;
        const tables = uniqueMahjongConfigs(this.mahjongTableConfigs());
        if (tables.length === 0)
            return "当前没有配置任何麻将机。";
        const lines = [`🀄️ 麻将机列表（${tables.length} 台）`];
        for (const table of tables) {
            const state = this.mahjongTables.get(table.tableId) ?? { waiting: [], activeSessions: {} };
            const activeCount = Object.keys(state.activeSessions).length;
            const waitingCount = state.waiting.length;
            const statuses = [
                ...(activeCount > 0 ? [`游玩中 ${activeCount}/${tableSize}`] : []),
                ...(waitingCount > 0 ? [`等位 ${waitingCount}/${tableSize}`] : []),
            ];
            lines.push(`- ${table.displayName}｜别名：${table.aliases.length > 0 ? table.aliases.join("、") : "无"}｜${statuses.join("；") || "空闲"}`);
        }
        return lines.join("\n");
    }
    async billing(sender) {
        const result = (await this.client.previewCheckoutByIdentity(this.identity(sender)));
        return this.formatCheckoutPreview(result, sender, "【结算账单】", true);
    }
    async logout(sender, bot) {
        const existing = this.logoutInFlight.get(sender.id);
        if (existing)
            return existing;
        const task = this.performLogout(sender, bot);
        this.logoutInFlight.set(sender.id, task);
        try {
            return await task;
        }
        finally {
            if (this.logoutInFlight.get(sender.id) === task)
                this.logoutInFlight.delete(sender.id);
        }
    }
    async performLogout(sender, bot) {
        const result = (await this.client.confirmCheckoutByIdentity(this.identity(sender), false));
        const playerId = String(result.playerSettlement.playerId);
        if (playerId)
            this.removeMahjongPlayer(playerId);
        return this.formatAndNotifyCheckout(result, sender, "✅ 退场成功 · 结算账单", bot);
    }
    async formatAndNotifyCheckout(result, sender, title, bot) {
        const settlement = result.playerSettlement;
        const records = result.settlements;
        const checkoutAdjustments = result.checkoutAdjustments;
        const pricingCapAdjustments = result.pricingCapAdjustments;
        const checkoutAdjustmentKeys = new Set(checkoutAdjustments.map(adjustmentKey));
        const pricingCapAdjustmentKeys = new Set(pricingCapAdjustments.map(adjustmentKey));
        const sessionPreviews = records.map((rec) => {
            const s = rec.settlement;
            const sessionAdjustments = rec.adjustments.filter((adjustment) => {
                const key = adjustmentKey(adjustment);
                return !checkoutAdjustmentKeys.has(key) &&
                    !pricingCapAdjustmentKeys.has(key) &&
                    !isPricingCapAdjustment(adjustment);
            });
            const sessionSubtotal = toNumber(s.subtotal);
            return {
                sessionId: s.sessionId,
                label: s.label,
                startedAt: s.startedAt,
                endedAt: s.endedAt,
                status: "closed",
                subtotal: sessionSubtotal,
                total: sessionSubtotal + sessionAdjustments.reduce((sum, adjustment) => sum + toNumber(adjustment?.amount ?? 0), 0),
                chargeItems: rec.chargeItems,
                adjustments: sessionAdjustments,
            };
        });
        const synthetic = {
            settlementPreview: {
                playerId: settlement.playerId,
                subtotal: settlement.subtotal,
                total: settlement.total,
            },
            sessionPreviews,
            chargeItems: result.chargeItems,
            checkoutAdjustments,
            pricingCapAdjustments,
            globalCapWindows: result.globalCapWindows,
            wallet: result.wallet,
        };
        const receipt = await this.formatCheckoutPreview(synthetic, sender, title, false);
        const recipients = [...new Set([...(this.config.staffUserIds ?? []), ...(this.config.logoutNotifyUserIds ?? [])])];
        if (recipients.length > 0 && bot?.broadcast) {
            const channelIds = recipients.map((id) => (id.includes(":") ? id : `private:${id}`));
            await bot.broadcast(channelIds, receipt);
        }
        return receipt;
    }
    async wallet(sender) {
        const result = (await this.client.getWalletByIdentity(this.identity(sender)));
        return formatWallet(result.wallet, this.config.currencyName);
    }
    async benchmarkApi(sender, rawCount) {
        const count = rawCount == null || rawCount === "" ? 3 : Number(rawCount);
        if (!Number.isInteger(count) || count < 1 || count > 10)
            return "次数须为 1 到 10 的整数。";
        const samples = [];
        for (let index = 0; index < count; index++) {
            const startedAt = performance.now();
            await this.client.getWalletByIdentity(this.identity(sender));
            samples.push(performance.now() - startedAt);
        }
        const min = Math.min(...samples);
        const max = Math.max(...samples);
        const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
        return [
            `📡 PRiSM API 测速（钱包查询，${count} 次）`,
            `最小：${formatNumber(min)} ms`,
            `平均：${formatNumber(average)} ms`,
            `最大：${formatNumber(max)} ms`,
        ].join("\n");
    }
    async versions() {
        let backendVersion = "不可用";
        try {
            backendVersion = formatReleaseVersion(await this.client.getVersion());
        }
        catch {
            // The Bot version remains useful when the backend is offline or too old.
        }
        return [
            "PRiSM 版本信息",
            `Bot：${exports.version}`,
            `后端：${backendVersion}`,
        ].join("\n");
    }
    async items(sender) {
        const result = (await this.client.getAssetsByIdentity(this.identity(sender)));
        const holdings = result.holdings;
        if (holdings.length === 0)
            return "您当前没有任何物品。";
        return ["🎒 --- 您拥有的物品 ---", ...holdings.map(formatInventoryItem)].join("\n");
    }
    async history(sender) {
        const result = (await this.client.getSessionHistoryByIdentity(this.identity(sender)));
        return formatHistory(result.sessions, this.config.currencyName);
    }
    async lock(sender) {
        await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
            type: "door.open",
            target: { kind: "facility", ref: this.config.defaultDoorDeviceId },
        });
        return "🔑 门锁指令已发送";
    }
    async powerOn(sender, rawDeviceRef) {
        const deviceRef = cleanText(rawDeviceRef);
        if (!deviceRef)
            return commandUsage("prism_on");
        return this.power(sender, deviceRef, "on");
    }
    async powerOff(sender, rawDeviceRef) {
        const deviceRef = cleanText(rawDeviceRef);
        if (!deviceRef)
            return commandUsage("prism_off");
        return this.power(sender, deviceRef, "off");
    }
    async coin(sender, rawDeviceId, rawCount) {
        const deviceId = cleanText(rawDeviceId);
        if (!deviceId)
            return commandUsage("prism_coin");
        const { value, error } = parsePositiveInt(rawCount, "prism_coin", "数量", 1);
        if (error)
            return error;
        const result = await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
            type: "coin",
            target: { kind: "game_machine", id: deviceId },
            payload: { count: value },
        });
        const failure = this.getCommandFailureMessage(result);
        if (failure)
            return `❌ 执行失败：${failure}`;
        return `🪙 已为 ${deviceId} 投入 ${value} 个币`;
    }
    async scan(sender, rawDeviceId, rawSubject) {
        const deviceId = cleanText(rawDeviceId);
        const subject = cleanText(rawSubject);
        if (!deviceId || !subject)
            return commandUsage("prism_scan");
        const result = await this.client.requestScanByIdentity(this.identity(sender), {
            deviceId,
            provider: this.config.defaultScanProvider || "aime",
            subject,
        });
        const failure = this.getCommandFailureMessage(result);
        if (failure)
            return `❌ 执行失败：${failure}`;
        return `💳 使用尾号为 ${subject.slice(-4)} 的卡刷卡成功`;
    }
    async redeem(sender, rawCode) {
        const code = cleanText(rawCode);
        if (!code)
            return commandUsage("prism_redeem");
        const result = (await this.client.redeemCodeByIdentity(this.identity(sender), code));
        const grantedAssets = result.grantedAssets;
        if (grantedAssets.length === 0)
            return "兑换成功，但没有获得任何物品。";
        return ["✅ 兑换成功！您获得了以下物品：", ...grantedAssets.map(formatRedeemedItem)].join("\n");
    }
    async listActiveSessions(sender) {
        const result = (await this.client.listActiveSessions());
        const sessions = (result?.sessions ?? []);
        this.syncMahjongTableStates(sessions);
        const tableByLabel = new Map(uniqueMahjongConfigs(this.mahjongTableConfigs()).map((table) => [
            mahjongSessionLabel(table),
            table,
        ]));
        const players = groupSessionsByPlayer(sessions);
        const groups = await this.buildPlayerGroups(players, tableByLabel);
        this.mergeWaitingSeats(groups);
        return formatPlayerGroups(groups, this.config.mahjongTableSize ?? 4);
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
    async power(sender, deviceRef, state) {
        const result = await this.client.requestDeviceCommandByIdentity(this.identity(sender), {
            type: state === "on" ? "power.on" : "power.off",
            target: { kind: "facility", ref: deviceRef },
            payload: { state },
        });
        const failure = this.getCommandFailureMessage(result);
        if (failure)
            return `❌ 执行失败：${failure}`;
        const deviceLabel = result.action.payload.deviceLabel;
        return state === "on" ? `✅ ${deviceLabel} 启动成功` : `🛑 ${deviceLabel} 关闭成功`;
    }
    getCommandFailureMessage(result) {
        const action = result?.action;
        if (action?.status === "expired" || action?.status === "rejected") {
            return action.payload?.executorFailure?.message || "命令执行被拒绝或超时";
        }
        return null;
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
        const groups = { groups: [] };
        const groupByLabel = new Map();
        const musicLabel = this.config.loginSessionLabel?.trim() || "音游区间";
        for (const player of players.values()) {
            player.displayName = await this.displayNameForPlayer(player);
            const nonMusic = player.sessions.filter((session) => Boolean(session.label) && session.label !== musicLabel);
            const source = nonMusic.length > 0 ? nonMusic : player.sessions;
            const selected = source.reduce((latest, session) => !latest || sessionStartedAt(session) > sessionStartedAt(latest) ? session : latest, undefined);
            const label = selected?.label || musicLabel;
            let group = groupByLabel.get(label);
            if (!group) {
                group = { label, table: tableByLabel.get(label), players: [] };
                groupByLabel.set(label, group);
                groups.groups.push(group);
            }
            group.players.push(player);
        }
        return groups;
    }
    mergeWaitingSeats(groups) {
        for (const [tableId, state] of this.mahjongTables) {
            const table = uniqueMahjongConfigs(this.mahjongTableConfigs()).find((candidate) => candidate.tableId === tableId);
            if (!table)
                continue;
            const label = mahjongSessionLabel(table);
            let group = groups.groups.find((candidate) => candidate.label === label);
            if (!group) {
                group = { label, table, players: [] };
                groups.groups.push(group);
            }
            for (const seat of state.waiting) {
                if (group.players.some((player) => player.playerId === seat.playerId))
                    continue;
                const existing = groups.groups.flatMap((candidate) => candidate.players)
                    .find((player) => player.playerId === seat.playerId);
                for (const candidate of groups.groups) {
                    if (candidate !== group)
                        candidate.players = candidate.players.filter((player) => player.playerId !== seat.playerId);
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
            || (sender.name && sender.name !== sender.id ? sender.name : "")
            || "未知昵称";
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
    removeMahjongPlayer(playerId) {
        for (const state of this.mahjongTables.values()) {
            delete state.activeSessions[playerId];
            state.waiting = state.waiting.filter((seat) => seat.playerId !== playerId);
        }
    }
    mahjongTableConfigs() {
        return resolveMahjongTableConfigs(this.config.mahjongTableConfigs ?? []);
    }
    syncMahjongTableStates(sessions) {
        const tables = uniqueMahjongConfigs(this.mahjongTableConfigs());
        const tableByLabel = new Map(tables.map((table) => [
            mahjongSessionLabel(table),
            table,
        ]));
        // All playerIds that still have at least one active session in the backend.
        // Used to evict waiting seats for players who have fully checked out externally.
        const allActivePlayerIds = new Set(sessions.map((s) => String(s.playerId ?? "")).filter(Boolean));
        const activeByTable = new Map();
        for (const session of sessions) {
            const table = tableByLabel.get(session.label ?? "");
            const playerId = String(session.playerId ?? "");
            const sessionId = String(session.id ?? "");
            if (!table || !playerId || !sessionId)
                continue;
            const active = activeByTable.get(table.tableId) ?? {};
            active[playerId] = sessionId;
            activeByTable.set(table.tableId, active);
        }
        for (const table of tables) {
            const state = this.mahjongTables.get(table.tableId) ?? { waiting: [], activeSessions: {} };
            state.activeSessions = activeByTable.get(table.tableId) ?? {};
            // Remove seats that have been promoted to active, or whose players have
            // fully left the backend (no entry session remaining — orphan eviction).
            state.waiting = state.waiting.filter((seat) => !state.activeSessions[seat.playerId] && allActivePlayerIds.has(seat.playerId));
            if (state.waiting.length > 0 || Object.keys(state.activeSessions).length > 0 || this.mahjongTables.has(table.tableId)) {
                this.mahjongTables.set(table.tableId, state);
            }
        }
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
    async targetSender(actor, targetSubject, bot) {
        const subject = normalizeTargetSubject(targetSubject);
        if (!subject)
            return actor;
        const denied = this.targetStaffDenied(actor);
        if (denied)
            return denied;
        try {
            const user = await bot?.getUser?.(subject);
            return { id: subject, name: user?.name || subject };
        }
        catch {
            return { id: subject, name: subject };
        }
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
    async formatCheckoutPreview(result, sender, title = "【结算账单】", isPreview) {
        const currency = this.config.currencyName;
        const preview = result.settlementPreview;
        const playerId = preview.playerId;
        const subtotal = preview.subtotal;
        const total = preview.total;
        const previewedAt = parseDateTime(preview.previewedAt);
        const sessionPreviews = result.sessionPreviews;
        const pricingCapAdjustments = result.pricingCapAdjustments;
        const checkoutAdjustments = result.checkoutAdjustments;
        const wallet = result.wallet;
        const balanceBefore = toNumber(wallet?.balanceBefore ?? 0);
        const balanceAfter = toNumber(wallet?.balanceAfter ?? 0);
        const lines = [];
        lines.push(title);
        lines.push(await this.resolvePlayerDisplay(sender, playerId));
        const hasNonZeroSessionTotal = sessionPreviews.some((session) => toNumber(session?.total ?? 0) !== 0);
        const hasNonZeroAdjustment = hasAdjustmentEntries(checkoutAdjustments, sessionPreviews);
        if (!hasNonZeroSessionTotal && !hasNonZeroAdjustment) {
            lines.push("");
            lines.push("本次未产生费用");
            lines.push(`余额：${formatNumber(isPreview ? balanceBefore : balanceAfter)}${currency}`);
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
                lines.push(`游玩时长：${formatDurationValue(minutes)}｜计价：${formatNumber(sTotal)}${currency}`);
            }
            else if (startDt) {
                lines.push(`入场：${formatHM(startDt)}  （${status === "active" ? "计费中" : "已关闭"}）`);
            }
            const sessionAdjustments = (sPrev?.adjustments ?? []);
            for (const adj of sessionAdjustments) {
                const amount = toNumber(adj.amount);
                if (amount === 0)
                    continue;
                const adjLabel = adj.label || adj.source || "优惠";
                lines.push(`  └ ${adjLabel}：${formatNumber(amount)}${currency}`);
            }
        }
        const cappedWindows = result.globalCapWindows.filter((window) => toNumber(window?.currentAmount) !== toNumber(window?.amountApplied));
        if (cappedWindows.length > 0) {
            lines.push("");
            lines.push("封顶：");
            for (const window of cappedWindows) {
                const label = window.ruleLabel || "封顶时段";
                const startedAt = parseDateTime(window.windowStartedAt);
                const datedLabel = startedAt ? `${formatMD(startedAt)} ${label}` : label;
                const currentAmount = toNumber(window.currentAmount);
                const amountApplied = toNumber(window.amountApplied);
                const priceCap = toNumber(window.priceCap);
                const paidBefore = toNumber(window.paidBefore);
                const details = [`上限${formatNumber(priceCap)}`];
                if (paidBefore > 0)
                    details.push(`已计${formatNumber(paidBefore)}`);
                lines.push(`- ${datedLabel}：${formatNumber(currentAmount)} → ${formatNumber(amountApplied)}${currency}（${details.join("，")}）`);
            }
        }
        const visibleCheckoutAdjustments = checkoutAdjustments.filter((adjustment) => {
            const amount = toNumber(adjustment.amount);
            const isOverride = cleanText(adjustment?.source).startsWith("staff.override:");
            return amount !== 0 && !isOverride;
        });
        lines.push("");
        const cappedTotal = Math.max(0, toNumber(subtotal) + pricingCapAdjustments.reduce((sum, adjustment) => sum + toNumber(adjustment?.amount ?? 0), 0));
        lines.push(`计费总价：${formatNumber(cappedTotal)}${currency}`);
        const hasManualAdjustment = checkoutAdjustments.some((adjustment) => cleanText(adjustment?.source).startsWith("staff.override:"));
        if (visibleCheckoutAdjustments.length > 0) {
            lines.push("");
            for (const adjustment of visibleCheckoutAdjustments) {
                const amount = toNumber(adjustment.amount);
                const label = adjustment.label || adjustment.source || "优惠";
                lines.push(`${label}：${formatNumber(amount)}${currency}`);
            }
        }
        if (hasNonZeroAdjustment) {
            if (visibleCheckoutAdjustments.length > 0)
                lines.push("");
            lines.push(`${hasManualAdjustment ? "调整后价格" : "优惠后价格"}：${formatNumber(total)}${currency}`);
        }
        if (isPreview) {
            lines.push(`当前余额：${formatNumber(balanceBefore)}${currency}`);
            lines.push(balanceAfter >= 0
                ? `预计结账后余额：${formatNumber(balanceAfter)}${currency}`
                : `预计结账后余额：余额不足（还差 ${formatNumber(-balanceAfter)}${currency}）`);
        }
        else {
            lines.push(`扣款后余额：${formatNumber(balanceAfter)}${currency}`);
        }
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
function resolveMahjongTableConfigs(structured) {
    const tables = new Map();
    for (const input of structured) {
        const displayName = cleanText(input.displayName);
        const tableId = displayName;
        const aliases = [...new Set((input.aliases ?? []).map(cleanText).filter(Boolean))];
        const pricingConfigIds = (input.pricingConfigIds ?? []).map(cleanText).filter(Boolean);
        if (!tableId || !displayName || pricingConfigIds.length === 0)
            continue;
        const table = { tableId, displayName, aliases, pricingConfigIds };
        for (const alias of aliases)
            tables.set(alias, table);
    }
    return tables;
}
function uniqueMahjongConfigs(tables) {
    return [...new Map([...tables.values()].map((table) => [table.tableId, table])).values()];
}
function mahjongSessionLabel(table) {
    return table.displayName;
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
function sessionStartedAt(session) {
    const value = Date.parse(session.startedAt ?? "");
    return Number.isFinite(value) ? value : 0;
}
function formatPlayerGroups(groups, tableSize) {
    const populatedGroups = groups.groups.filter((group) => group.players.length > 0);
    const total = new Set(populatedGroups.flatMap((group) => group.players.map((player) => player.playerId))).size;
    if (total === 0)
        return "🫥 窝里目前没有玩家呢";
    const lines = [`[总计 ${total} 人]`];
    for (const group of populatedGroups) {
        const heading = group.table
            ? `${group.table.displayName} ( ${group.players.length}/${tableSize} )`
            : `${group.label} ( ${group.players.length}人 )`;
        lines.push(`\n${heading}：\n${formatPlayerNames(group.players)}`);
    }
    return lines.join("\n");
}
function formatPlayerNames(players) {
    return players.map((player) => `- ${player.displayName || player.playerId || "未知玩家"}`).join(", ");
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
function formatReleaseVersion(value) {
    const record = value && typeof value === "object" ? value : {};
    const release = cleanText(record.version) || "unknown";
    const revision = cleanText(record.revision);
    return !revision || revision === "unknown" ? release : `${release} (${revision})`;
}
function normalizeTargetSubject(value) {
    const subject = cleanText(value);
    const separator = subject.indexOf(":");
    return separator > 0 ? subject.slice(separator + 1) : subject;
}
function formatPlayerReference(sender, provider = "qq") {
    const name = sender.name && sender.name !== sender.id ? sender.name : "未知昵称";
    return `${name}（${provider.toUpperCase()}：${sender.id}）`;
}
function adjustmentKey(adjustment) {
    const id = cleanText(adjustment?.id);
    if (id)
        return `id:${id}`;
    return JSON.stringify([
        adjustment?.source ?? "",
        adjustment?.label ?? "",
        toNumber(adjustment?.amount ?? 0),
    ]);
}
function isPricingCapAdjustment(adjustment) {
    return adjustment?.pricingCapHistory != null ||
        cleanText(adjustment?.source).startsWith("time.cap:") ||
        cleanText(adjustment?.id).startsWith("time-cap:");
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
    return adjustments.some((adjustment) => toNumber(adjustment.amount) !== 0) || sessionPreviews.some((session) => session.adjustments.some((adjustment) => toNumber(adjustment.amount) !== 0));
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
function formatMD(dt) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
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
function formatInventoryItem(row) {
    let line = `- ${row.assetName || row.assetCode || "资产"} (x${formatNumber(row.quantity)})`;
    if (row.expiresAt)
        line += `\n  到期: ${formatDateTime(row.expiresAt)}`;
    return line;
}
function formatRedeemedItem(row) {
    return `- ${row.assetName || row.assetCode || "资产"} x${formatNumber(row.quantity)}`;
}
function formatWallet(rows, currency) {
    const paid = rows
        .filter((row) => String(row.assetCode).toLowerCase().includes("paid"))
        .reduce((sum, row) => sum + toNumber(row.quantity), 0);
    const free = rows
        .filter((row) => String(row.assetCode).toLowerCase().includes("free"))
        .reduce((sum, row) => sum + toNumber(row.quantity), 0);
    const other = rows
        .filter((row) => {
        const code = String(row.assetCode).toLowerCase();
        return !code.includes("paid") && !code.includes("free");
    })
        .reduce((sum, row) => sum + toNumber(row.quantity), 0);
    const total = paid + free + other;
    return [
        "💰 --- 钱包余额 ---",
        `可用: ${formatNumber(total)} ${currency} (共 ${formatNumber(total)})`,
        `  - 付费: ${formatNumber(paid)}`,
        `  - 免费: ${formatNumber(free)}`,
    ].join("\n");
}
function formatHistory(sessions, currency) {
    if (sessions.length === 0)
        return "暂无历史记录";
    const lines = [`📜 最近 ${sessions.length} 条记录:`];
    for (const session of sessions) {
        const end = session.endedAt ? formatDateTime(session.endedAt) : "进行中";
        const cost = session.total == null ? "未结算" : `${formatNumber(session.total)} ${currency}`;
        lines.push(`- [${session.sessionId}] ${formatDateTime(session.startedAt)} -> ${end} (${cost})`);
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
