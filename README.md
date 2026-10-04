# dsh-projection-persist

三个修复的集合（宿主半边 + 浏览器半边，不修改 DSH 安装目录里的任何文件）：

1. **会话标题**在一次连接重建（Host generation reset）中**不再掉成「未命名」**；
2. **会话列表**不再被控制帧洪水逐帧全量重建（合帧到 rAF，实测约 6.3× 降幅）；
3. **运行中的转圈动画**恢复旋转（本机 WebView2 恒报 `prefers-reduced-motion: reduce`）。

> 症状：会话列表里的标题会短暂变成「未命名」（英文界面是 *Untitled*），随后自行恢复。

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件，包含宿主半边与浏览器半边。

---

## 症状与根因

会话列表闪一下、标题短暂变成「未命名」，本质是**连接被重建时投影（projection）被清空**：

1. 宿主 `dsh-api-gateway` 对 `/api/remote.mux` 的 WebSocket 心跳默认 **2000 ms**，且 `MAX_MISSED_HEARTBEATS` **硬编码为 2**。
2. 客户端主线程只要卡顿 **> 4 s**，宿主即判定连接已死并 `socket.terminate()`。
3. 浏览器侧收到 **close 1006**，`ConnectionController` 重建 connection generation。
4. `SessionManager.handleConnected()` 对**每一个常驻投影 store** 调用 `store.clear()`。
5. `ProjectionValueStore#clear()` 的实现是**删除每一行**，于是标题丢失，回落到 `t("session.untitled")` = **「未命名」**，直到 `refreshList()` 返回才恢复。

关键代码锚点（版本 `0.2.0-rc.2`）：

- `@deepseek-ai/dsh-api-gateway/lib/index.js` — `startHeartbeat()`、`MAX_MISSED_HEARTBEATS = 2`
- `@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/manager.js` — `handleConnected()` 里的 `store.clear()` 循环
- `@deepseek-ai/dsh-api-session-controller/lib/client.js` — `ProjectionValueStore#clear()`

## 这个插件做了什么

替换 `ProjectionValueStore.prototype.clear`，**保留每一行的值，只丢弃序号水位**：

```js
function retainValues() {
  for (const [key, row] of this.rows) {
    if (row.kind === "sequenced") this.rows.set(key, { kind: "cached", value: row.value });
    this.changed(key);
  }
}
```

- 值保留 ⇒ 标题仍可读，`buildListSnapshot()` 不再回落到「未命名」。
- 水位丢弃 ⇒ 紧随其后的 `refreshList()` 送来的 cached 块可以照常覆盖。
- 每条 `sequenced` 行**原地降级**为 `cached` 行。

> **为什么不能简单地改成空操作（no-op）**：`apply()` 会拒绝 seq 不更新的帧
> （`if (row?.kind === "sequenced" && seq <= row.seq) return;`），
> 保留旧水位会把新一代连接的低 seq 帧永久挡住 —— 所以必须保留「重置水位」的语义。

同时它也会覆盖**懒创建**的 store（包装 `manager.projectionStore`），并在卸载时完整回滚。

## 安装

### 从 GitHub 安装（推荐）

在 DSH profile 目录里用 pnpm 添加本仓库：

```bash
dsh plugin --profile <你的 profile> add github:iuuuuuuuu/dsh-projection-persist
```

或者直接进 profile 目录手工装：

```bash
cd "$DSH_HOME/profiles/<你的 profile>"
pnpm add github:iuuuuuuuu/dsh-projection-persist
```

安装后把包名加进 profile 的 `package.json` → `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-projection-persist"
      ]
    }
  }
}
```

改 `dsh.profile.bundles` 会触发热重载，**通常不需要重启**。

### 手工安装（不经过 pnpm）

把本仓库复制成 `$DSH_HOME/profiles/<你的 profile>/node_modules/dsh-projection-persist/`，
再把 `"dsh-projection-persist"` 追加进同一 profile `package.json` 的 `dsh.profile.bundles`。

## 验证

插件生效时，宿主半边会在 `<DSH_HOME>/logs/projection-persist.log` 追加一行安装记录：

```json
{"kind":"install","ok":true,"revision":9,"installed":"instance","wrapped":true,"swept":42,"prototypePatched":true,"stores":42,"framePatch":"patched","spinner":"installed","watch":"watching"}
```

也可以直接查诊断端点（GET 返回当前 revision）：

```bash
curl http://127.0.0.1:3080/dsh-projection-persist
# {"ok":true,"name":"projection-persist","revision":9}
```

## 回滚

两种方式都是热生效，任选其一：

1. 删掉 `node_modules/dsh-projection-persist/cordis.patch.yml` 里的 `- insert:` 行；
2. 从 profile 的 `dsh.profile.bundles` 里移除 `"dsh-projection-persist"`，或直接删掉整个包目录。

插件卸载时会自动恢复原 `clear()` 与 `manager.projectionStore`。

## 兼容性

- 只依赖 `sessions` 服务，不声明任何 peerDependencies，因此不会被兼容性检查判为不兼容。
- 不修改 DSH 安装目录，DSH 升级不会覆盖它。
- 已验证版本：`@deepseek-ai/dsh-api-session-controller` `0.2.0-rc.2`。
- 只影响**管理器持有的**投影 store；会话自身持有的 store 不在此列（该 store 的 `seqOf` 有其它消费者）。

## 另外两个修复（同一个客户端半边）

### 1. 会话列表整表重建合帧

`SessionManager` 的列表 `Notifier` 原本用 `markDirty()`（microtask 合帧）。控制帧是一条条独立的 socket task，
microtask 根本合不掉它们，于是 8–15 个控制帧 ⇒ 8–15 次 `projectList()` 全量重建 + 无条件 `list.set()`。
插件把**列表** notifier 的 `markDirty` 换成上游预留但从未启用的 `markFrameDirty()`（rAF 合帧，last-write-wins 不变，
`ensureFresh()` 保证同步读仍然新鲜）。**`Session.notifier` 不动** —— 它的同步契约由 `beginSubmission`/`finishSubmission` 依赖。

实测（交错 A/B × 3 轮，8 s/窗）：

| | 触发次数 | 整表重建 | `list.set` | 每次触发重建 |
|---|---|---|---|---|
| 打补丁 | 176 | **14** | 34 | **0.080** |
| 未打补丁 | 288 | 145 | 165 | **0.503** |

约 **6.3×**（按观测帧率折算约 18/s → 约 1.8/s）。

### 2. 运行中的转圈动画

在 WebView2 宿主里 `matchMedia("(prefers-reduced-motion: reduce)")` **恒为 `true`**，
命中 `StateDot.module.css` 的 `@media (prefers-reduced-motion: reduce) { .spinnerMotion, .spinnerArc { animation: none } }`，
于是会话正在跑的时候不转圈。插件注入一段自有 `<style>`，在**同一个** media 块内用 `!important` 重声明关键帧
（选择器限定 `svg[data-state="ongoing"] > g` 与 `circle[class*="spinnerArc"]`，不误伤另外 9 个合法的 reduced-motion 块），
并在 `<head>` 上挂一个 `childList` `MutationObserver`，元素一旦被谁删掉就立刻重装（实测 `healedAtMs: 83`）。

单独关掉转圈修复：`localStorage["dsh-projection-persist.spinner"] = "off"`。

## 心跳阈值（另一条链路，本插件不负责）

把 `websocketHeartbeatIntervalMs` 调大只会降低重连**发生频率**，不能消除重连本身。两者叠加才是完整防线：

- 调大心跳间隔 ⇒ 减少重连**频率**；
- 本插件 ⇒ 重连**真的发生时**标题不再丢。

## License

MIT
