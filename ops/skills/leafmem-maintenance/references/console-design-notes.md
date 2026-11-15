# console 设计优化经验（2026-11-15 ui-design 方法论轮实证）

> 从 SKILL.md 外置（token 预算）；改 console 界面时必读。

## console 设计优化经验（2026-11-15 ui-design 方法论轮实证，改 console 界面时必读）

- **服务与同步**：console 由 leafmem-agent serve（端口见 `~/.leafmem/agent-service.json`，本机 3377）提供；**dist/console 是静态服务产物**——改 `src/console/index.html` 后必须 `npm run build` 同步（md5 比对 src=dist），禁对着旧页面评审新代码（ui-design 存量界面铁律同源）。
- **改前备份+提交**：`cp src/console/index.html /tmp/` 备份；commit+push 当场（lesson 616e3457）；CHANGELOG 归 [Unreleased]。
- **布局铁律两条（实测）**：① 视口空白带禁靠 CSS 拉伸卡片填——grid 行高由最高列决定时，矮卡下方是**背景空白带**（卡内 gap 达标≠页面达标，须 JS 实测卡高与行高差）；修法=grid-template-areas 重排（矮卡横排堆叠+高卡跨行），零内容损失；② 卡内空白（stretch 拉伸）比页面空白更糟——**先量卡内 gap 再定 start/stretch**：gap 大=内容不齐→补真实数据行拉平信息量后 stretch；gap 小=内容齐→start。
- **空状态/披露/危险操作三判据**：空态禁空白屏（用法说明+示例点击即执行+范围规模）；过滤/稀疏化必须公开排除量（CHI U2.13.3：「显示 X 隐藏 Y」实时披露）；行内破坏性按钮 hover 才显（opacity 0→1）。
- **API 陷阱**：`/v1/stats` 裸调用（无 scope 参数）返回 0——必须带 scopeQuery（`scope=all` 等），否则页面显示假 0。
- **验收三通道**：npm test 全量（339/339）+ design_lint（file:// 直开 API 型 SPA 报 Fetch 错=假阳，活服务验收为准）+ ego-browser 真实画面与交互（**收尾必 finish({keep:[]})**，见 ego-browser 收尾纪律）。

