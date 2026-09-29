# pvault · 报销流程 设计规格（计划 5）

> 状态：待用户审查
> 日期：2026-09-28
> 项目目录：`E:\codex-project\pvault`
> 上承：`docs/superpowers/specs/2026-09-24-pvault-invoice-design.md` 第 6 节（报销流程）
> 形态：PWA + 本地打包 APK（两条分发路径并存）

---

## 0. 一句话

把散在发票列表里的票打成一单，跟着它走到公司打钱为止，**钱到账时顺手记一笔收入**。

---

## 1. 与发票规格的关系

发票规格第 6 节已经把这件事的骨架定死了：三态状态机、发起报销、到账自动入账、差额行、删除保护。**本规格不改那些结论**，只做三件事：

1. 把第 6 节里**留白的实现细节**补上（入口、多选交互、模块分层、事务边界）；
2. 记下动手前核实代码时**发现的既有缺口**（见 §3.4、§6.5）；
3. 给出可执行的任务划分，交给实现计划。

计划 4 已交付发票本体，并**已建好 `reimbursements` 表与 `by_status` 索引**（`app/schema.js:55`）——本计划是从零填它，不是改表。

**用户在本轮澄清里的两项选择（原话保留）**：入口选「分段切换 + 显式『选择』按钮」；到账默认值选「按规格原样：合计 + settings.lastAccountId + 分类『退款』」。

---

## 2. 明确不做

沿用发票规格第 2 节已排除的项，另加本计划自己的边界：

| 不做 | 原因 |
|---|---|
| 报销审批流（多人、多级） | 自用，只有「我提交、公司打钱」这一条线 |
| 一张票拆到多笔账 | 发票金额是固定的，拆账是记账那边的事 |
| 报销单导出成 PDF / 打印 | 同发票那条：需要排版引擎，要留底就导出备份 |
| 报销单挂到账目（`txns`）之外的地方 | 到账只生成一笔 `kind: 'income'` 的交易，不做多笔分摊 |
| 自动把报销单里的票同步给公司系统 | 需要联网，与「数据不离开手机」冲突 |
| 报销单之间移动发票的批量工具 | 先做「移除」+「加入」两个单步，够用；批量是另一个交互 |

---

## 3. 数据模型

### 3.1 `reimbursements`（表已存在，本计划开始真正写入）

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `title` | 标题，默认「9月报销 · 3 张」，可改 |
| `status` | `draft` 待提交 / `submitted` 已提交 / `settled` 已到账 |
| `createdAt` / `submittedAt` / `settledAt` | 三个时间点，后两个可空 |
| `accountId` | 到账账户，可空（到账时才需要） |
| `txnId` | 到账时生成的收入账 id，可空 |
| `note` | 备注（本计划不做编辑入口，字段留着） |
| `settledCents` | **本计划新增**：实际到账金额（整数分）。发票合计由 `listInvoicesOf` 现算，这个字段单独存是因为公司少报/扣税/抹零真实存在，而「差额」必须拿它减合计；不存的话差额就无从算起 |

索引：`by_status`（已建）。

> 关于 `settledCents`：它**不是**为了让金额对齐而存在的——规格 §6.4 明确「不为了对齐而阻止用户」。它存在的唯一理由是**差额需要两个数**，而其中一个（实际到账）只有用户知道。为 null 表示**没有可用的实际到账金额**：还没到账，或已到账但没填金额（见 §8 的四组合表）。
>
> **加这个字段不需要动 `DB_VERSION`，也没有迁移**：IndexedDB 没有字段级 schema，`app/schema.js` 的 `STORES` 只定义 keyPath 与索引（`reimbursements: { keyPath: 'id', indexes: [['by_status','status']] }`，`schema.js:55`），记录上多一个字段照存不误。`DB_VERSION` 只在**加表 / 加索引**这类结构变化时才需要上调——那一段的注释（`schema.js:6-13`）专门讲过「漏了这一步没有任何测试能发现」。本计划对结构**零改动**：要用的表和索引计划 4 都已建好。

### 3.2 `invoices` 的两个既有字段

- `reimbursementId`：本计划第一次真正写它。**它被两个方向读写**，见 §6。
- `archived`（仅存档）：为真时**不进这条流水线**，也不出现在待报销筛选里。

### 3.3 `txns` 上新增的字段

到账生成的收入账带：

- `kind: 'income'`
- `source: 'reimbursement'`
- `reimbursementId`：指向来源报销单

`app/store.js` 的 `addTransaction` **会重建 txn 对象、只取固定字段**（`store.js:36-52`），所以 `reimbursementId` 必须**显式加进那个对象**，否则传进去也会被静默丢掉——这是动手前核实出来的第一个坑（§6.5）。

`txns` 表是 `keyPath: 'id'`，另有 `by_occurredAt` / `by_kind` 两个索引（`schema.js:17`）。加一个字段既不动 keyPath 也不动索引，**不需要迁移**。

### 3.4 备份（**带一个既有缺口的修补**）

`buildBackup` 的 `data` 要增加 `reimbursements` 数组（发票规格 §8.1 的要求），同时：

- `app/backup-store.js` 的 `ARRAY_STORES` 加 `'reimbursements'`；
- `app/backup.js` 的 `buildBackup` 打包它、`summarizeBackup` 计数它；
- **不要**加进 `REQUIRED_ARRAYS`——那张表的含义是「老备份必须也有」，加进去会把所有既有备份判成坏文件（发票那次踩过同一个坑，`backup.js:4` 有注释）。

**第二个坑（动手前核实出来的）**：`ARRAY_STORES` 里现在**没有** `reimbursements`。也就是说**今天导出的备份不带报销单**。计划 4 建了表、规格 8.1 要求进备份，但那一句没落地。本计划补上，并且要在手动验证清单里补一条**跨版本**的往返项：用**本计划之前**的版本导出一份备份（其中没有 `reimbursements` 键），导入新版本，确认**不报错**，且本机原有的报销单**被保留**。

> **关于「保留」而不是「清空」（2026-09-28 实现时实测修正）**：本条最初写的是「确认报销单表**被清空**而不是报错」，**那句是错的**。导入侧的清空判据是 `Array.isArray(data[name])`（`backup-store.js` 的 `clears`），老备份里连这个键都没有 → 不进清理清单 → 本机现有的报销单**照旧留着**。这与 `invoices` / `receivables` 等**同属 `ARRAY_STORES` 的表**一致，也是 `docs/手动验证清单.md` 里白纸黑字那条纪律的体现：「没有替补的东西，一律不删」——把老备份导入一台已有数据的设备，不该把本机数据抹掉。
>
> **`settings` 是例外，别把它算进「一致」里**：它走的是无条件的 `clears.push('settings')`（`backup-store.js:637`），整表覆盖——导入一份老备份之后，本机多出来的设置行会被清掉。这条例外是有意的（设置是整表语义），但它意味着「所有表都保留本机」这句话是错的。
>
> 容易混的是 `arrayOrEmpty`：它只在两处起作用——导入循环里的 `for...of` 兜底（`:496`），以及 `invoiceFiles` 的清理判据（`:636`）；**对 `ARRAY_STORES` 里的表，它不参与 `clears`**（那里是 635 行的 `Array.isArray` 直接判）。所以别把两处判据混成一句。
>
> 还有一处容易推错方向：**老备份永远不会被「规范化」**，它是既成的密文。导出侧的 `buildBackup` 用 `?? []` 兜底，作用是**保证今后导出的每一份包都带这个键**（新包键在、值为 `[]` 时**会**清表，与老包处置相反）——这两种包不是一回事，也是 `hasInvoices` 那套字段存在的理由。

---

## 4. 模块划分

| 文件 | 职责 | 依赖 | 可单测 |
|---|---|---|---|
| `app/reimburse-model.js`（新） | 纯逻辑：状态机合法性、标题生成、合计、差额、发票状态推导 | **无** | ✅ 纯模块 |
| `app/reimburse-store.js`（新） | 数据层：创建 / 改名 / 加票 / 移票 / 提交 / 到账 / 删除 | `db.js`、`store.js`、`invoice-store.js` | ❌ 靠 fake-browser 探针 |
| `app/ui/reimburse-view.js`（新） | 报销单列表 + 详情 | model、store、`sheet.js`、`keypad.js`、`dom.js` | ❌ 靠模拟器实测 |
| `app/ui/invoice-view.js`（改） | 顶部细分段切换 + 多选模式 | reimburse-store | ❌ 同上 |
| `app/store.js`（改） | `addTransaction` 开一个「同一事务追加条目」的口子 | — | 已有测试 |
| `app/backup.js` + `app/backup-store.js`（改） | `reimbursements` 进备份 | — | 已有测试 |

**为什么纯逻辑要单独成模块**（而不是像方案 B 那样一股脑塞进 store）：项目里 `invoice-model.js`、`budget.js`、`receivable.js`、`theme.js` 走的都是「纯逻辑独立、可脱离 IndexedDB 单测」这条路。状态机与差额计算放进 store 之后，就只能靠 fake-indexeddb 探针来验，而那些恰恰是**最容易写错、最值得用纯单测钉死**的部分（状态流转的合法性、边界的取整与负数）。**这条与方案取舍的理由一并记在 §11。**

---

## 5. `reimburse-model.js`（纯逻辑）

全部为同步纯函数，不碰 DOM / IndexedDB，因此可以在 Node 里直接 import 单测。

### 5.1 状态机

```
STATUS = { DRAFT: 'draft', SUBMITTED: 'submitted', SETTLED: 'settled' }
```

| 函数 | 判据 | 说明 |
|---|---|---|
| `isStatus(v)` | 三值之一 | 读库取到脏值时兜底用 |
| `canEdit(r)` | `status === 'draft'` | 只有草稿能改名、加票、移票 |
| `canSubmit(r)` | `status === 'draft'` | |
| `canSettle(r)` | `status === 'submitted'` | **草稿不能直接到账**：没提交就谈不到到账 |
| `canDelete(r)` | 恒 true | 任何状态都能删，但已生成收入账时要走二次确认（§7.5） |
| `isActive(r)` | `draft \|\| submitted` | 列表分组的「进行中」 |

**为什么 `canEdit` 只放 draft**：一旦提交给公司，票就不该再动——动了之后手机上显示的合计与公司收到的那张单对不上，而用户没有任何办法知道公司按哪个数打的款。要改就说明提交错了，正确做法是先撤回（本计划不做撤回，见 §11 的取舍）。

### 5.2 计算与推导

| 函数 | 输入 → 输出 |
|---|---|
| `autoTitle(monthTs, count)` | 时间戳 + 张数 → 「9月报销 · 3 张」 |
| `sumInvoiceCents(invoices)` | 发票数组 → 整数分。**空数组得 0** |
| `diffCents(settledCents, invoices)` | 实际到账 − 发票合计。`settledCents` 为 null 时返回 null（**没有可用的实际到账金额**：还没到账，或已到账但没填金额——「只标记到账、不记收入」落的就是 null，见 §8 的四组合表；两种情形都没有差额可谈） |
| `invoiceStatus(inv)` | 三态：`'stored'`（archived）/ `'reimbursed'`（有 reimbursementId）/ `'pending'`。**这是筛选用的判据**，只看发票自身的两个字段 |
| `invoiceBadge(inv, reimb)` | 显示文案：`仅存档` / `待报销` / `报销中`(draft) / `已提交`(submitted) / `已到账`(settled) |

**三态与五文案为什么分开**：筛选只需要知道「在不在报销单里」（§7.2 的五个筛选），而列表上那一行标签要回答的是「报出去了吗、到哪一步了」。前者是判据、后者是呈现，合成一个函数会让筛选依赖报销单状态，而报销单状态在筛选那一刻未必读得到（列表页只查 invoices 表时拿不到报销单）。所以 `invoiceStatus(inv)` **不接报销单参数**：拿不到报销单，判据就只能建立在发票自己的 `archived` / `reimbursementId` 两个字段上——有 `reimbursementId` 就是 `'reimbursed'`，绝不能退回「待报销」，那会让用户重复报销同一张票。（要看报销单状态的是 `invoiceBadge(inv, reimb)`，它才需要第二个参数。）

**「仅存档」的优先序**：一张票若同时 `archived` 且有 `reimbursementId`，`invoiceStatus` 返回 `'stored'`。但**这种状态本不该存在**（§6.4 明令禁止），返回 stored 只是让界面不至于显示成一个无法解释的东西。

### 5.3 金额口径

一律**整数分**，与 `app/money.js` 一致，与 `invoices.amountCents` 同一套口径。`sumInvoiceCents` 内部对每张票取 `Number(inv.amountCents) || 0`——脏记录按 0 计，绝不让一张坏票把整单合计变成 `NaN`（`NaN` 会一路传到界面上显示成「¥NaN」，而且 `JSON.stringify` 会把它变成 `null`、跟着备份跑到下一台设备）。

---

## 6. `reimburse-store.js`（数据层）

**每条写操作都是一个事务**——这是本计划最重要的一条纪律，理由见 §6.5。

### 6.1 读

| 函数 | 说明 |
|---|---|
| `listReimbursements()` | 全部报销单，`createdAt` 倒序 |
| `getReimbursement(id)` | 单条，未命中返回 `null` |
| `listInvoicesOf(reimbId)` | 走 `by_reimbursement` 索引；顺序与 `listInvoices` 同一套（开票日期倒序、同日按录入时间倒序）——索引查询的顺序实际是随机的，`invoice-store.js:34` 为此写过一段注释 |
| `listPendingInvoices()` | 待报销：`getAll('invoices')` 之后自己 filter `!archived && !reimbursementId`。**绝不能用 `by_reimbursement` 索引去查「没有报销单」的票**——IndexedDB 不索引键值为 null / undefined 的记录，`IDBKeyRange.only(null)` 还会直接抛 `DataError`（`schema.js:25-29` 专门写过这个坑：连 `index.count()` 都会给出一个偏小的数，而且看不出来错） |
| `summary()` | 列表页分组用：进行中 N 单 / 已到账 M 单、待报销 K 张与合计 |

**回写（2026-09-28 终审后）：本版本不提供 `summary()`，等价能力在两处现算。** 表格里这一行读作
**能力要求**，不是函数清单——要的是「列表页能给出分组与待报销汇总」，而不是「必须有一个叫这个名字的函数」：

- 报销单分组计数（进行中 N 单 / 已到账 M 单）由 `ui/reimburse-view.js` 在渲染时**自己分组**。
  它本来就必须逐单取回发票才能显示「N 张 · 合计」，分组是顺手的事；再单开一个 store 函数只是多一次读库。
- 「待报销 K 张与合计」落在 `ui/invoice-view.js` 已有的汇总里（`invoice-store.summary()`，本计划之前就有）。

两处都**现算**的代价是同一口径写了两遍（一处按报销单分组、一处按发票聚合），
收益是不为一个只有界面需要的形状多造一层数据层 API。

### 6.2 写（每条一个事务）

| 函数 | 事务内的动作 |
|---|---|
| `createReimbursement({ invoiceIds, title, now })` | 写一条 `reimbursements`（status=draft）+ 把这些发票的 `reimbursementId` 指向它 |
| `renameReimbursement(id, title)` | 写回 title（`canEdit` 前置检查） |
| `addInvoicesTo(reimbId, invoiceIds)` | 这些发票的 `reimbursementId` 指向它（`canEdit` + 逐张校验，见 §6.4） |
| `removeInvoiceFrom(reimbId, invoiceId)` | 那张票的 `reimbursementId` 置 null（`canEdit`） |
| `submitReimbursement(id, now)` | `status=submitted` + `submittedAt`（`canSubmit`） |
| `settleReimbursement(id, { settledCents, accountId, categoryId, createTxn, now })` | 见 §6.3——**本计划唯一一个跨三张表的事务** |
| `deleteReimbursement(id, { deleteTxn })` | 见 §6.6 |

### 6.3 到账（跨 `txns` / `reimbursements` / `invoices` 三张表，一个事务）

```
settleReimbursement(id, { settledCents, accountId, categoryId, createTxn, now })
```

事务内：

1. 更新报销单：`status='settled'`、`settledAt=now`、`accountId`、`settledCents`；
2. 若 `createTxn` 为真：写一笔 `kind='income'` 的交易（金额 = `settledCents`、`source='reimbursement'`、`reimbursementId=id`、`occurredAt=now`），并把它的 id 写回报销单的 `txnId`；
3. 若 `createTxn` 为假：`txnId` 保持 null（有些人报销款和记账分开管，规格 §6.3 明说可以不记账）。

**这三步必须同事务**：第 2 步写完、第 1 步没写完，就会出现「钱记上了、报销单还停在已提交」——用户看到没到账，再点一次「标记到账」，于是**记出第二笔收入**。

**交易怎么进同一个事务**：`store.addTransaction` 目前自己开事务（`db.putAll`），拿不到跨表控制权。本计划给它加一个**可选的第二参数**：

```js
export async function addTransaction(input, { extraEntries = [] } = {})
```

`extraEntries` 会被拼在 `entries` 后面、由同一个 `db.putAll` 写下去。报销到账把「更新报销单」那一条塞进去，于是两处一起落库。**默认参数保证既有 5 处调用点一个字都不用改。**

**为什么不用「先写交易再 update 报销单」的补偿式写法**：中途失败留下的半截状态没有自愈路径（应用重启也不会去比对），而它恰好是「用户会重试」的那种状态——重试的代价是账目里多一笔假的收入。**宁可整笔失败**。

### 6.4 发票进出的校验（全在写之前，且与事务同一个函数）

- 已在**别的**报销单里的票：`createReimbursement` / `addInvoicesTo` **跳过它**、不抛错，最后把跳过的张数返回给界面提示「N 张已经在别的报销单里，没加进来」。
- `archived === true` 的票：**拒绝**，返回错误「这张票标了『仅存档』，不参与报销」。它不该出现在待报销列表里，所以正常路径选不到；但从详情页逐张加时可能撞上。

**两种处置为什么不一样**（一个跳过、一个拒绝），判据是**用户有没有做错事**：

- 「已经在别的单里」往往是**列表刚打开之后的状态变化**（另一个标签页先建了单、或用户自己刚在别处加过）。用户没有做错，不该被一个报错打断整批操作——跳过、告知、其余照常，是这里唯一合理的处置。
- 「仅存档」是用户**亲手动过勾**的标记，它在这条流水线里是一个明确的排除项（规格 §6.1）。选中它说明界面给了他一个不该给的选择（或者他理解错了），**必须停下来讲清楚**，否则「仅存档的票悄悄进了报销单」正是规格明令禁止的那个状态。

同一段校验还要守住**反方向**：一张 `reimbursementId` 非空的票，在 `invoice-editor` 里被勾成「仅存档」时必须**拒绝保存**并提示「先把它从报销单里移出」。规格 §6.1 的「不允许一张票同时是『已提交待报销』和『仅存档』」靠这一条落地。
- **一张票同时是「已提交待报销」和「仅存档」是不允许的**（规格 §6.1）。因此在 `invoice-editor` 侧要加一条反向保护：若某张票 `reimbursementId` 非空，勾「仅存档」时要先提示「先把它从报销单里移出」，**不允许保存**。
- 已在**本单**里的票重复加入：幂等跳过。

### 6.5 本层最重要的一条纪律

`importBackup` 的注释（`backup-store.js:639`）与 `db.replaceAllRecords` 的注释（`db.js:125`）反复讲过同一件事：**需要一起成立的多处写入，必须收在一个事务里**，否则中途失败会留下一个自相矛盾的库，而用户没有自愈路径。

报销流程天然是多处写入的（一单对应 N 张票；到账对应 1 笔交易 + 1 条报销单 + 1 个 txnId），所以本模块**每个写函数都只用一次 `db.putAll` / `db.replaceAllRecords`**，不做「先写这个再写那个」。

**动手前核实出来的第一个坑**：`store.addTransaction` 会**重建** txn 对象、只取固定字段（`store.js:36-52`），传 `reimbursementId` 进去会被**静默丢掉**——不报错，只是那笔收入永远找不回它的报销单，而删除保护（§7.5）正是靠 `txnId` 找它的。所以要在那个对象里显式加上这个字段。

**第二个坑**：`invoice-store.saveInvoice` 的 `reimbursementId: existing?.reimbursementId ?? null`（`invoice-store.js:98`）意味着它**保留**旧值但**不接受**传入。这个行为对编辑发票是**对的**（编辑一张票不该顺手把它的报销关系抹掉），但它同时意味着**建立/解除报销关系必须走本模块自己的写入**，不能指望 `saveInvoice`。本模块因此直接用 `db.put` 写 invoices 记录，而不是绕道 `saveInvoice`——绕道还会连带触发 `validateInvoice`（报价单一侧要传全字段才能过），把「改一个字段」变成「重写一整条」。

### 6.6 删除保护（规格 §6.3）

`deleteReimbursement(id, { deleteTxn })` 的事务内：

1. 把本单所有发票的 `reimbursementId` 置 null（**它们回到「待报销」**，不是被删掉——票是用户的东西，报销单只是它的分组）；
2. 删掉报销单记录；
3. `deleteTxn` 为真时，删掉那笔收入账。

**界面侧**：若 `txnId` 非空，先弹二次确认「这笔报销生成过一笔收入，要不要一起删？」，两个按钮分别是「一起删」和「只删报销单，留下收入」。**两边都留会变成对不上的账**，所以必须问，且不能默认。

---

## 7. 界面

### 7.1 入口：发票 Tab 顶部的细分段切换

发票 Tab 顶部（搜索框之上）加一行两段的 pill 切换：**发票 | 报销单**。

- 默认停在「发票」，保持既有用户习惯不变；
- 切到「报销单」→ 渲染 §7.4 的列表；
- 切换状态存模块级变量，与 `invoice-view.js` 现有的 `filter` / `keyword` 同一做法（切走再回来不该被重置）。

**为什么不用底部加第 5 个 Tab**：发票规格 §7.1 已定死底部四个（记账 / 发票 / 统计 / 密码箱），5 个 Tab 在手机上偏挤；而报销单在概念上就是发票的一种分组视图，放在发票 Tab 内部语义更顺。

### 7.2 多选与发起报销

- 发票列表右上角一个显式的**「选择」**按钮（不是长按：长按在 PWA/APK 里没有任何提示，用户不会自己发现）；
- 进入多选后：列表项左侧出现勾选框，顶部「选择」变成「取消」，**筛选项自动切到「待报销」**（避免用户把已报销的票又选进来），搜索框保留；
- 选中 ≥1 张时，底部浮出操作条：左边写「**已选 N 张 · ¥X**」，右边是那颗按钮「**发起报销**」
  （**回写 2026-09-28**：原文写的是「发起报销（N 张 · ¥X）」一整颗按钮，实现把它拆成了左右两半
  ——左边是「选了什么」、右边是「按下去会发生什么」。信息一个字都没丢，而按钮成为唯一的行动点；
  加票态同理：左边同样是「已选 N 张 · ¥X」，右边换成「加到「X」」）；
- 点它 → 弹一个半屏 sheet（`openSheet`）确认标题（默认 `autoTitle(当前月, N)`，**可改**）→ 确认后调 `createReimbursement` → 成功后**直接跳到该报销单详情**（用户刚做完一件事，应该看到它的结果，而不是回到列表自己找）；
- 可选项为 0 时操作条不出现（不是禁用态——禁用态会让人猜为什么）。

### 7.3 五个筛选（补一个既有缺口）

发票规格 §7.2 写的是五个筛选：全部 / 待报销 / **已报销** / 未挂账 / 仅存档。而 `app/ui/invoice-view.js:12-17` 目前只有四个——「已报销」正因为计划 4 还没有报销流程而缺着。`invoiceStatus`（§5.2）落地后补上：

| id | 判据 |
|---|---|
| `all` | 全部 |
| `pending` | `invoiceStatus(inv) === 'pending'`（既有，改用 `invoiceStatus`） |
| `reimbursed` | **新增**：`invoiceStatus(inv) === 'reimbursed'` |
| `unlinked` | `!txnId`（既有） |
| `stored` | `invoiceStatus(inv) === 'stored'`（既有） |

三个三态判据一律**复用 §5.2 的 `invoiceStatus`**，不各写一遍 `archived` / `reimbursementId`：两份等价判据迟早漂移。因此 §5.2 的优先序在筛选上一体适用——脏组合「既存档、又在单里」判 `stored`，**既不算待报销、也不算已报销**。

`unlinked` 是独立的判据，**不看 `archived`**：一张仅存档、又没挂到任何账目上的票，照旧算「未挂账」。`archived` 说的是「不参与报销追踪」，`txnId` 为空说的是「没挂到账目上」——两件事互不包含，把归档的票从「未挂账」里藏起来只会让用户找不到那些还没挂账的存档票。（这条曾无人定义过，2026-09-28 质检后在此定案。）

### 7.4 报销单列表与详情（规格 §7.5）

**列表**：按状态分两组——**进行中**（draft / submitted，组内按创建时间倒序）、**已到账**（settled，组内按 `settledAt` 倒序）。空状态一句引导 + 「去发票里选几张」的按钮（点了切回发票分段并进入多选，把「怎么开始」直接铺好）。

每项显示：标题、张数、**发票合计**、状态、创建日期；`settled` 的项额外显示实际到账金额与差额（若有）。

**详情**：

- 顶部：标题（draft 时可点改）、状态、时间线（创建 → 提交 → 到账，未发生的节点灰显）；
- 票的列表（**本版本是文字行，不做横向缩略图**——缩略图要为每张票 `createObjectURL` 喂 `<img>`，而本仓有过「对象 URL 不回收」的前科：漏掉 `revokeObjectURL` 就是每进一次详情页漏一批 blob（票多时几十 MB，且没有任何地方会报错）。要做它，得先有一条「离开视图时统一回收」的生命周期，那是另一件事。文字行不是死角：点一行就能进发票编辑器看到原图与全部字段）；
- 合计行；已到账时下面多一行「实际到账」与「差额 -¥12.00」（差额为 0 时**不显示**这一行——没有差额就没有信息）；
- 操作区按状态给按钮：draft → 「提交」「加票」「移除」（每张票上有移除入口）；submitted → 「标记到账」「撤回」不做（见 §11）；settled → 只读 + 「删除」；
- 删除入口始终在，走 §6.6 的二次确认。

### 7.5 到账确认（规格 §6.3）

点「标记到账」弹 sheet，三行：

| 行 | 默认 | 说明 |
|---|---|---|
| 金额 | 发票合计（`sumInvoiceCents`） | 用项目现有的 `createKeypad`（与记账一致，不自造一套）。**可改**——公司少报/扣税/抹零真实存在 |
| 账户 | `settings.lastAccountId`（取不到则第一个账户） | 与记账面板「上次用的账户」**同一个来源**，不是另搞一套记忆 |
| 分类 | 「退款」（`cat-refund`） | 已核实：这个分类确实存在于默认种子（`schema.js:94`），且 `kind` 就是 `income`，不必新建 |

底部一个勾选「**只标记到账，不记收入**」（默认**不勾**，即默认记一笔）。勾上后 `createTxn=false`。

确认 → `settleReimbursement` → 详情页刷新为已到账态。

### 7.6 导航与刷新

`app/router.js` 的 `TABS` **不动**（仍是四个）。报销单详情是发票 Tab 内部的一个视图状态，不是新路由。

**渲染竞态**：新增的报销单列表/详情与 `invoice-view.js` 现有的 `viewSeq` / `paintSeq` 是同一类问题——`main.js` 的 `renderSeq` 只保证「哪一次渲染有权挂 tabbar」，拦不住视图自己在 `await` 之后写 `root`。新视图必须照 `invoice-view.js:28-36` 的写法自带渲染序号，否则「进报销单页后立刻点统计」会复现「统计高亮着却显示报销单」的错位（那段注释里有完整复现路径）。

---

## 8. 错误处理与边界

| 场景 | 处置 |
|---|---|
| 到账金额为空 / 解析不出数字 | **要记账时**（默认）拒绝提交：面板本地提示「请输入到账金额」，**一次写都不发起**（早先靠 store 的 `BAD_INPUT` 兜，会白发起一次注定失败的写入，文案也是存储层口吻的「到账金额不对，这次没记上」）。「只标记到账、不记收入」勾上时**不校验金额**（那条路径不产生交易，没有金额可填），此时落库的 `settledCents` 是 **`null`**，不是 0 |
| 到账金额为 0 | **允许，但要二次确认**：报销确实可能一分没报回来（公司拒报），所以 0 是合法值；但手滑清空输入框也会得到 0，所以确认文案写明「到账金额是 ¥0.00，确定吗？」 |
| 到账金额为负数 | 拒绝。报销到账不会是负数；真填了负数只可能是误触了减号 |
| 发票合计为 0（单里一张票都没有，或票的金额都是 0） | 到账金额默认取 0，但要挡住「顺手确认出一笔 0 元收入」。**回写（2026-09-28 终审后）：本版本没有「焦点落在金额输入框」这个落点**——金额走的是项目自定义的 `createKeypad`（`ui/keypad.js`），面板里没有原生 `input`、也就没有输入焦点可放。真正承担这件事的是 §8 下面那条「显式输 0 → 二次确认」（确认文案写明「到账金额是 ¥0.00，确定吗？」，由它来拦住手滑） |
| 到账金额与合计不一致 | **允许**，详情页显示差额行（规格 §6.4） |
| 报销单里一张票都没有 | 允许存在（用户可能先建单再加票），但列表上显示「还没有发票」而不是「0 张」 |
| 提交时发票已被删 | 单里就不再有它（`listInvoicesOf` 查不到），合计按现存票算；不报错 |
| 在别的报销单里的票被选 | 跳过 + 提示跳过的张数（§6.4） |
| 「仅存档」的票被加 | 拒绝 + 提示原因（§6.4） |
| 删一张属于某单的发票 | `invoice-store.deleteInvoice` 直接删，报销单里随之少一张。**不阻止**——票是用户的，他有权删；但界面上要提示「这张票在『X 报销』里，删掉后那一单会少一张」 |
| 报销单已 settled 后又删了它的收入账 | 允许（从记账侧删）。报销单的 `txnId` 成悬空引用，详情页显示「那笔收入已被删除」而不是显示一个点不开的链接 |
| 配额满 / 存储失败 | 沿用 `putInvoice` 的中文兜底话术（`invoice-store.js:45-64`），不把英文异常抛给用户 |

`settleReimbursement` 的 `settledCents` 只有四种组合，行为按审查结论**钉死**如下
（`createTxn:true + 空` 由 store 的金额校验拒绝，`createTxn:false + 空` 的 `null` 保留不折成 0）：

| createTxn | 金额 | 行为 |
|---|---|---|
| true | 有值 | 正常记账：一笔 `kind='income'` 交易 + 报销单同批写入，`settledCents` = 该值 |
| true | 空 | 面板本地报「请输入到账金额」，**不发请求**：无交易、报销单状态不变 |
| false | 有值 | 只标记到账，落 `settledCents` = 该值，`txnId` 保持 null |
| false | 空 | 只标记到账，落 **`settledCents: null`**（不是 0）——「没填」与「真的是 0 元」必须分开 |

为什么这四种要写进规格：`settledCents` 兜底成 0 时，`false + 空` 会静默落库 0，详情页显示
「实际到账 ¥0.00 / 差额 -¥3,025.00」，把「没填」记成了「公司给了 0 元」。这四种组合由
`tests/settle-sheet.test.js`（面板全链路）与 `tests/reimburse-store.test.js`（数据层）各钉一遍。

---

## 9. 测试策略

| 层 | 方式 |
|---|---|
| 纯逻辑 | `node --test --test-isolation=none` 新增 `tests/reimburse-model.test.js`：状态机每个函数的**真值与假值两侧**、`autoTitle` 的跨年/跨月/0 张、`sumInvoiceCents` 的脏数据（`null` / 字符串 / `NaN` 成分）、`diffCents` 的正负与 null、`invoiceStatus` / `invoiceBadge` 的六种组合（`invoiceBadge` 那侧含 `reimb` 为 null） |
| 存储层 | 新增 `tests/reimburse-store.test.js`，用 `tests/helpers/fake-browser.js` 装内存环境：创建/加票/移票/提交/到账/删除的完整流转、**发票回退到待报销**、跳过已在别单的票、拒绝仅存档、删除保护的两个分支、以及**事务原子性**（注入一次写失败，确认库里没有半截状态） |
| 备份 | 扩 `tests/backup.test.js` / `backup-store.test.js`：`reimbursements` 进包、老备份（无该键）导入**不报错且本机报销单被保留**（缺键即不进 `clears`，与其余所有表一致）、往返后字段一致 |
| 真实渲染 | **回写（2026-09-28 终审后）：本版本的渲染类验证落到真机 / 手动清单。** 原文要求用 CDP 驱动（模拟器或本机无头浏览器，见 `pvault-tools/accept-backup.mjs` 的做法），而实现这一版的那台开发机上**没有可用的浏览器**（无头 Chromium 起不来：Mojo 的命名管道被受限沙箱挡在启动阶段，puppeteer 缓存里那份 Chrome 152 也是坏的，`--version` 就 exit 3）。降级的具体影响与替代做法写在 `docs/手动验证清单.md`：那里把渲染类条目分成了「自动测试钉住的」与「**真机量**」两类，后者是布局、层级、真实测量与真 IndexedDB 事务——**桩盖不住的那部分一条不落地挂到真机**，而不是删掉要求。原文点名的五项里，**列表分组 / 多选 / 发起报销 / 到账 sheet / 差额行**这五项的行为（点了之后库里多了什么、屏幕上写着什么）已经由 `tests/reimburse-view.test.js`、`tests/invoice-view.test.js`、`tests/settle-sheet.test.js` 在 Node 里逐个钉住（DOM 与 IndexedDB 用桩、中间两层 store 是真的），真机上只剩「看得对不对」 |
| 真机 | `docs/手动验证清单.md` 加「报销」小节 |

**纪律沿用项目既有两条**：新写的断言必须先用**变异实验**证明「它真的会红」（不要恒真断言）；失败消息须含「哪一项 · 哪个输入 · 实际值」。

---

## 10. 任务划分（交给实现计划细化）

1. `reimburse-model.js` + 单测（纯逻辑，先落地）
2. `backup.js` / `backup-store.js` 接入 `reimbursements` + 备份测试（**独立于界面，先补这个既有的洞**）
3. `store.addTransaction` 加 `extraEntries` + 既有测试回归
4. `reimburse-store.js` 的读 + 建/改名/加票/移票 + 探针
5. `reimburse-store.js` 的提交/到账/删除 + 事务原子性探针
6. `invoice-view.js` 的五个筛选 + `invoiceStatus` 接入（补「已报销」）
7. `invoice-view.js` 的分段切换 + 多选模式
8. `reimburse-view.js` 列表 + 详情
9. 到账 sheet（金额/账户/分类 + 「只标记到账」）
10. `invoice-editor` 的「仅存档 ↔ 报销单」互斥保护
11. 收尾：`sw.js` 的 `CACHE` 版本 +1 并补 `ASSETS`、手动验证清单加「报销」小节、渲染实测
    （**回写 2026-09-28**：这一步的「渲染实测」在本版**没有自动化落点**——开发机上没有可用的浏览器，
    照 §9 那一条的说明落到真机 / 手动清单）

每个任务完成时都要：全量测试绿（当前基线 **305 pass / 0 fail**）。

---

## 11. 风险与取舍

| 风险 | 处理 |
|---|---|
| 到账记出第二笔收入 | 三处写入收在一个事务（§6.3）；探针里专门注入失败验原子性 |
| 发票被删后报销单合计与公司单据对不上 | 详情页的合计是**现算**的（`listInvoicesOf`），不做缓存——宁可显示当下的真相 |
| 提交后想改票 | 本计划**不做撤回**：`canEdit` 只放 draft。理由见 §5.1；真需要时再加，代价是「用户提交错了只能删单重建」 |
| `ARRAY_STORES` 补 reimbursements 影响既有备份 | 加键不改格式版本；老备份没这个键时**不进 `clears`**、本机报销单被保留——判据是 `Array.isArray(data[name])`（`backup-store.js:635`），缺键即不清，与 `invoices` / `receivables` 等同属该清单的表一致（**`settings` 是例外**，它无条件整表覆盖）。`arrayOrEmpty` 对这批表**不参与** `clears`，它只在导入循环的 `for...of` 兜底与 `invoiceFiles` 的判据（`:636`）处起作用。专门写测试钉住「导出带上」与「往返后字段一致」两端 |
| 分段切换让顶部变挤 | 分段做得很矮（一行 pill），搜索框与筛选行不动；真机上实测后再调 |
| 新增视图的渲染竞态 | 照 `invoice-view.js` 的 `viewSeq` 写法自带序号（§7.6） |
| **渲染类验证没有自动化**（本版开发机上没有可用的浏览器，见 §9 那一条的回写） | 不删要求、降级落地：行为部分由 Node 侧测试（桩 DOM + 桩 IndexedDB、中间两层 store 是真的）钉住，**桩盖不住的**（布局 / 层级 / 真实测量 / 真 IndexedDB 事务）逐条挂进 `docs/手动验证清单.md` 的「**真机量**」条目。已知代价：合并前那台机器给不出任何「界面长什么样」的证据，回归只能靠真机复核 |
