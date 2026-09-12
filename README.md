# koishi-plugin-prism

[![npm](https://img.shields.io/npm/v/koishi-plugin-prism.svg)](https://www.npmjs.com/package/koishi-plugin-prism)

**koishi-plugin-prism** 是用于连接 **PRiSM Next** 计费与设备管理系统的 Koishi 机器人插件。它可以替代旧版 `plugin-prism-neo-koishi`，为玩家和店员提供便捷的群内与私聊机器人交互指令。

## 🌟 功能特性

* 🎮 **玩家入场与结算**：通过 `/login` 和 `/logout` 指令开启或结算计费场次，支持 `/入场` 别名；命令回复会引用触发消息，结账账单可私聊通知管理员与指定用户。
* 💳 **账户钱包与资产管理**：支持查询钱包余额（`/wallet`）和持有的道具资产（`/items`）。
* 🀄 **麻将桌位集成**：包含 `/mahjong <tableId>`、`/上桌 <桌号>`、自动识别当前桌位的 `/下桌`，以及用于查看桌名、别名和状态的 `/麻将列表`。`上桌` 仅允许已通过 `login`/`入场` 开启默认入场会话的玩家使用。支持在桌位未满但已开局时进行中途补位（直接开始计费上桌），且玩家下桌时会自动显示剩余游玩人数。`list` 按 session 标签分组：有非音乐游戏 session 的玩家归入最新的非音乐标签，纯音乐玩家归入音乐标签；麻将桌额外显示当前人数和容量。已开局桌位会从后端活跃 session 自动恢复，未满桌候座仍由机器人进程暂存，重启后不会保留。
* 🔌 **硬件设备状态与电源管理**：可直接在聊天中查看设备状态（`/show`）、远程开启/关闭电源（`/on`、`/off`）、远程投币（`/coin`）和模拟刷卡（`/scan`）。
* 🎟️ **礼物兑换码**：使用 `/redeem <code>` 兑换系统发放的福利礼包。
* 🛠️ **管理员快捷指令**：允许管理员为指定平台用户增加或扣除余额，并覆盖结账金额后立即结账。

所有技术异常在聊天中只显示通用失败提示，不会包含后端名称、URL、网络状态、原始 `fetch` 错误或 HTTP 状态。完整原始异常会写入 Koishi 的 `prism` 日志，供管理员排查。

## ⚙️ 配置说明

在 Koishi WebUI 的插件配置页面中，填入以下选项：

| 配置项 | 类型 | 默认值 | 描述 |
| :--- | :---: | :---: | :--- |
| `baseUrl` | `string` | - | **必填**。PRiSM Next Server 的访问基准 URL（如 `https://prism-mmw.neri.moe`）。 |
| `shopCode` | `string` | - | 统一平台的店铺公开编号；单店兼容部署留空。 |
| `integrationToken` | `string` | - | **必填**。从 PRiSM 网页后台生成的 Integration API 令牌。 |
| `provider` | `string` | `"qq"` | 当前绑定的账号提供商平台名称（如 `"qq"`，`"discord"`）。 |
| `autoRegister` | `boolean` | `true` | 当玩家未注册时，是否在首次操作（如入场/查钱包）时自动在 PRiSM 中创建新玩家。 |
| `loginPricingConfigIds` | `string[]` | `[]` | 默认入场计费规则 ID 列表。 |
| `loginSessionLabel` | `string` | `"音游区间"` | 默认入场会话的标签文本。后端会按该标签对同一玩家的活跃会话去重，重复入场会被拒绝并提示。留空则不启用去重。 |
| `defaultDoorDeviceId` | `string` | - | 默认门锁设备的名称或别名，用于开门指令；配置项名称仅为兼容旧配置而保留。 |
| `defaultScanProvider` | `string` | `"aime"` | 默认模拟刷卡时的读卡器协议提供商（如 `"aime"`）。 |
| `currencyName` | `string` | `"金币"` | 账户货币在显示时的自定义单位名称。 |
| `resolveDisplayName` | `function` | - | 可选。自定义用于获取群内昵称作为玩家注册名的异步逻辑。 |
| `enableStaffCommands` | `boolean` | `false` | 是否开启管理员快捷指令。 |
| `staffUserIds` | `string[]` | `[]` | 允许执行管理员快捷指令的平台用户 ID（如 QQ 号）白名单。空列表不授予目标用户操作权限。 |
| `powerCommandsAdminOnly` | `boolean` | `false` | 关机是否仅允许 `staffUserIds` 中的管理员使用。`/on` 始终只允许已入场玩家使用。 |
| `logoutNotifyUserIds` | `string[]` | `[]` | 结账成功后额外私聊完整账单的平台用户 ID。通知收件人为该列表与 `staffUserIds` 的去重并集。 |
| `mahjongTableConfigs` | `object[]` | `[]` | 推荐的结构化麻将桌列表。每项填写显示名称、命令别名列表与计费方案 ID 列表。显示名称同时作为内部桌位锚点与 session 标签。 |

### 统一平台

配置 `baseUrl`、`shopCode` 和本店的 Integration 令牌后，插件调用 `/api/v1/shops/:shopCode/integration`；单店兼容部署调用 `/api/v1/integration`。

玩家在网页取得验证码后，向 Bot 发送 `prism.bind 验证码`。绑定使用消息发送人的 QQ，不接受代填 QQ。允许哪些群或私聊使用此指令，由店家在 Bot 框架中配置过滤；后端和插件不再维护群白名单或群聊/私聊限制。网页账号可以跨店使用，QQ 验证和余额分别属于各店；默认只允许绑定本店已有玩家，店主可以开启新玩家注册。

统一平台以店铺的入场规则和注册开关为准。Web 与 Bot 普通入场共享去重；显式的麻将规则继续使用桌位流程。店铺启用入场、出场或机器操作定位时，对应 Bot 操作会返回本店网页地址。玩家余额不足时结账失败并继续计时。

### 麻将桌配置

在 Koishi 配置页的 `mahjongTableConfigs` 中新增桌位，每一项填写：

```yaml
displayName: "🀄️ M.LEAGUE联名比赛专用机"
aliases: [a, 四麻A, 比赛机]
pricingConfigIds: [pricing-mahjong-a]
```

`displayName` 是该桌的稳定锚点和 session 标签；玩家输入的桌号、简称等均写入 `aliases`（至少一个）。麻将桌只读取这个结构化列表。

管理员快捷指令必须同时配置 `enableStaffCommands: true` 与 `staffUserIds`。它们使用现有 `integrationToken` 调用受限的余额调整和立即结账接口；目标用户参数使用 Koishi 的 `user` 选择器，只有白名单内的管理员可以操作其他用户。

## 📝 机器人指令列表

### 玩家指令
* `register` - 绑定或注册当前平台账号到 PRiSM 账户。
* `login` / `入场` - 开启当前玩家的计费场次。
* `logout` - 结算当前玩家的计费场次。
玩家在未产生任何费用时退场，机器人会简洁显示“本次未产生费用”和当前余额；存在收费或优惠明细时仍显示完整结算账单。负单价 session 会在区间明细中保留真实的负数计费贡献，只有后端汇总全部 session 后的最终应付金额会限制为不低于 `0`。
结账成功回执中的余额为后端已经完成扣款后的余额；只有 `/billing` 预览会显示当前余额与预计结账后余额。
方案内区间封顶直接计入对应计时费用；全局封顶按后端返回的结构化日期和时段逐条列出，不合并、不截断，并直接形成计费总价，不作为优惠。只作用于整次结账的资产优惠直接列在计费总价下方，不显示额外标题或 emoji，也不会误归属到最后一个 session。
在玩家退场或管理员覆盖结账成功后，机器人会向 `staffUserIds` 与 `logoutNotifyUserIds` 中的用户私聊同一份账单，账单会明确显示结账玩家身份。
同一玩家在前一次退场结账尚未完成时重复发送 `/logout` 或 `/退场`，机器人会复用同一次结账请求与账单，避免重复扣款。
账单和管理员代操作回执均使用“平台昵称（QQ：号码）”称呼玩家；平台暂时无法提供昵称时显示“未知昵称（QQ：号码）”，不会显示内部玩家 ID。
管理员 `/add` 增加免费余额；`/del` 按结账相同的顺序从可用免费余额、再从付费余额扣除，余额不足时会返回余额不足提示。
* `billing` - 预览当前玩家本场计费的消费费用。
* `wallet` - 查看当前玩家的钱包余额。
* `items` - 查看当前玩家持有的道具或资产。
* `list` - 查看当前在线/在店游玩玩家的列表，按 session 标签分组并对同一玩家去重；存在非音乐游戏 session 时取最新的非音乐标签，麻将桌显示当前人数和容量。已开局桌位由后端 session 恢复；未满桌候座由机器人进程暂存，机器人重启后不会保留。
* `show [deviceId]` - 查看设备电源与连接状态。
设备状态按后端的普通字符串契约显示；插件仍兼容历史数据库中的 JSON 字符串状态，避免旧记录显示为 `unknown`。
* `history` - 查看自己的历史游玩记录。
* `lock` - 为默认 TTLock 门锁生成一个 8 位随机临时密码（有效期 3 分钟）并回复密码。
* `on <deviceRef>` - 使用后台设备名称、别名或 `all` 请求启动电源；仅已通过 `login`/`入场` 开启活跃计费 session 的玩家可用。不接受 Home Assistant entity ID，成功回复使用后端返回的设备名称。
* `off <deviceRef>` - 使用后台设备名称、别名或 `all` 请求关闭电源；与 `/on` 一样仅允许已入场玩家使用，不接受 Home Assistant entity ID，`all` 显示为“所有设备”。
* `coin <设备名或别名> [count]` - 请求向后台配置的 Hinata IO 设备投币；需要玩家已入场。
* `scan <设备名或别名>` - 使用当前玩家后台绑定的 Aime 卡向设备刷卡，不在群聊中输入或显示卡号。
* `redeem <code>` - 兑换礼物码。
* `mahjong <tableId>` / `上桌 [tableId]` - 加入指定麻将桌；`/上桌` 未提供桌号时会引导查看 `/麻将列表`。仅允许已通过 `login`/`入场` 开启默认入场会话的玩家使用。支持在桌位未满但已开局时进行中途补位（即直接开始计费上桌）。
* `下桌` - 自动离开当前所在麻将桌，下桌后会停止计费，并显示该麻将桌的剩余游玩人数。
* `麻将列表` - 查看已配置机器的桌名、命令别名，以及空闲、等位或游玩中状态。
* `api测速 [次数]` - 连续查询自己的钱包，显示 Bot 到 PRiSM API 的最小、平均与最大延迟（默认 3 次，最多 10 次）。
* `versions` - 显示当前 Bot npm 包版本和后端发布版本；后端不可达时仍会显示 Bot 版本。

Bot 版本直接读取本 npm 包的 `package.json`，后端版本读取无需认证的 `GET /version`。插件发布遵循 SemVer；修复使用 patch、兼容新增功能使用 minor、不兼容改动使用 major，发布前通过 `npm version <patch|minor|major>` 自动更新包版本。

### 管理员快捷指令
启用 `enableStaffCommands`、配置 `staffUserIds` 白名单与 `staffSessionToken` 后可使用：
* `add <target:user> <amount:number>` - 为目标用户增加余额。
* `del <target:user> <amount:number>` - 从目标用户扣除余额。
* `overwrite <target:user> <amount:number> [reason:text]` - 覆盖目标用户本次结账金额，并立即执行结账；未填写原因时使用默认管理员调价原因。

## 🛠️ 本地开发与构建

1. 确保已安装 Node.js 和 `bun`。
2. 克隆本仓库：
   ```bash
   git clone https://github.com/nerimoe/koishi-plugin-prism.git
   cd koishi-plugin-prism
   ```
3. 安装依赖并执行编译：
   ```bash
   bun install
   bun run build
   ```
4. 运行单元测试：
   ```bash
   bun run test
   ```

### CI 自动发布

发布使用 GitHub Actions 的 npm Trusted Publishing。修改版本后推送带 `v` 前缀且与 `package.json` 一致的标签即可自动测试、构建并发布：

```bash
npm version patch
git push origin main --follow-tags
```

首次使用前，在 npm 包设置的 Trusted Publisher 中选择 GitHub Actions，填写仓库 `nerimoe/koishi-plugin-prism` 和工作流文件名 `publish.yml`，并允许 `npm publish`。

## 📄 开源协议

[MIT License](LICENSE)

统一平台支持 QQ 绑定、查人以及原有计费／设备命令。持有有效店铺 Integration 令牌的 Bot 不受玩家定位和扫码入口限制；玩家身份、入场要求、投币冷却及插件员工权限仍保留。查人合并后端持久化麻将名单和旧 Bot 桌位记录。普通入场的 `entry` 标签兼容旧 `loginSessionLabel`，不会误拒绝已入场玩家上桌。

2026-09-13 使用 Koishi 4.18.11 实际命令解析和本地 HTTP，对已有 MMW prism-next 快照运行旧新版对比：18 名在店玩家的账单／钱包／资产／历史与查人共 73 次查询文本一致；另测试入退场、四人麻将、余额调整、兑换、开关机、门锁、投币冷却、重复刷卡、离线和权限拒绝。QQ 消息本地注入，硬件使用本地模拟服务，不代表真实 QQ 投递或物理硬件验收。

### QQ 绑定与查人验收

QQ 绑定支持 Koishi 的 `qq` 和 `onebot` 平台，发送人 ID 必须是 QQ 号码；群／私聊过滤仍交给 Koishi。`/list` 使用店铺作用域接口并兼容 data 响应封装，人数统计包括尚未开局的麻将等待玩家，按玩家 ID 去重。只通过源码测试不能证明运行中的 Bot 已更新；npm 发行版与分支提交需要分别核对。

### 0.1.39

支持统一平台店铺 API、QQ／OneBot 绑定和麻将查人统计；兼容新版入场标签，修复已入场玩家无法通过 Bot 上桌的问题。
