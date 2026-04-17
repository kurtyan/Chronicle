# Slack Bot Webhook 场景头脑风暴

## 一、基础场景

### 场景 1: 消息自动创建任务 (核心场景)

**触发方式**: 
- 被 @mention 时自动创建任务
- 在特定频道发送消息时自动创建
- 通过 emoji reaction (如 :task: 表情) 标记消息为任务

**实现逻辑**:
```
Slack 消息 → Webhook → 服务端 → LLM 解析 → 创建任务
```

**Prompt 增强**:
```
输入消息：
- 发送者：@张三
- 内容："@yanke 帮忙看一下这个 PR，客户催得很急"
- 频道：#研发-日常
- 时间戳：https://company.slack.com/xxx

提取：
{
  "title": "Review 张三的 PR（客户催促）",
  "priority": "HIGH",
  "source": "Slack - #研发-日常",
  "from": "张三",
  "slackUrl": "https://company.slack.com/xxx",
  "context": "客户催得很急"
}
```

**用户交互**:
- 任务创建后，Slack 回复一条消息：
  - "✅ 已创建任务：Review 张三的 PR（客户催促） [查看任务] [调整优先级]"
  - 提供快捷按钮："紧急"/"普通"/"暂不处理"

---

### 场景 2: 进展快捷记录

**触发方式**:
- 在任务相关的 Slack 线程中回复，自动关联为进展
- 使用 `/progress 任务ID 进展内容` 斜杠命令
- 在任意消息加 emoji :progress: 快速记录

**实现逻辑**:
```
Slack 回复 → 检测是否关联任务 → 提取内容 → 添加到任务进展
```

**示例**:
```
[在任务线程中]
用户："PR 已经合并了，准备部署到测试环境"
Bot："✅ 已记录进展到任务『重构订单模块』"
```

---

### 场景 3: 任务完成快捷确认

**触发方式**:
- 在任务相关的 Slack 线程回复 "done"/"完成"/"搞定了"
- 使用 `/done 任务ID` 斜杠命令
- 加 emoji :white_check_mark: 到任务消息

**实现逻辑**:
```
关键词/命令 → 查找关联任务 → 标记完成 → 询问是否需要日报总结
```

**示例**:
```
用户："/done 123"
Bot："✅ 任务『重构订单模块』已标记完成\n📝 今日已完成 3 个任务，要生成日报吗？ [生成] [稍后]"
```

---

## 二、主动推送场景

### 场景 4: 每日晨会提醒

**触发**: 定时任务（如每天早上 9:00）

**推送内容**:
```
📋 今日任务概览 (2024-04-15)

🔥 高优先级待办 (2)
• 完成客户紧急需求评估 (截止今天)
• 修复支付模块 Bug

▶️ 进行中任务 (1)
• 重构订单模块 (已工作 2.5h)
  └─ 进展：PR 已提交，等待 Code Review

⏸️ 等待中任务 (1)
• 对接第三方物流接口
  └─ 阻塞原因：对方 API 文档未提供

📊 昨日统计
• 完成任务：3 个
• 有效工时：6.5h
• AFK：1h (会议)

[查看看板] [开始第一个任务]
```

---

### 场景 5: 任务状态变更通知

**触发**: 任务状态变化

**场景**:
- 任务被阻塞时 → 通知"任务已阻塞，原因：xxx"
- 高优先级任务即将到期 → 提前提醒
- 当前激活任务长时间无进展（如 2 小时）→ 询问是否 AFK

---

### 场景 6: AFK 恢复提醒

**触发**: 从 AFK 状态恢复

**实现**:
```
用户离开电脑 → 自动检测 AFK → 记录 AFK 时间
用户回到电脑 → 推送："欢迎回来！休息了 15 分钟。继续处理『重构订单模块』吗？ [继续] [切换任务]"
```

---

## 三、查询与交互场景

### 场景 7: 自然语言查询任务

**触发**: Slack 中发送 `/tasks 查询语句`

**示例**:
```
/tasks 我今天有什么紧急任务？
→ 返回今天的高优先级待办

/tasks 我在等什么？
→ 返回所有等待中的任务

/tasks 这周完成了什么？
→ 返回本周已完成任务列表
```

**实现**: 用 LLM 解析自然语言 → 转换为查询条件 → 返回结果

---

### 场景 8: 任务上下文追溯

**触发**: 在 Slack 中发送 `/context 任务ID`

**返回**:
```
任务『重构订单模块』完整上下文：

📝 任务创建
• 2024-04-10 由 Slack 消息自动创建
• 来源：@李四 在 #研发-日常 频道提及
• 原始消息：[查看]

📈 进展时间线
• 04-10 09:30 - 任务创建，开始处理
• 04-10 11:00 - 完成方案设计 [消息链接]
• 04-10 14:00 - 开始编码
• 04-11 10:00 - 提交 PR #234 [链接]
• 04-11 14:00 - 标记为等待中（等待 Code Review）

⏱️ 工时统计
• 总耗时：8.5h
• 实际工作：7h
• AFK：1.5h

🔗 相关链接
• Slack 消息：[3 条]
• PR：#234
• 文档：xxx
```

---

### 场景 9: 快捷操作面板

**触发**: 使用 `/taskpanel` 命令或点击菜单

**返回一个交互式消息**:
```
┌─────────────────────────────────────┐
│          🎯 任务快捷面板            │
├─────────────────────────────────────┤
│                                     │
│  当前激活：重构订单模块 (2.5h)      │
│                                     │
│  [添加进展]  [标记完成]  [AFK]      │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  快速切换：                         │
│  • 修复支付 Bug                     │
│  • 写技术文档                       │
│  • [+ 查看更多]                     │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  今日统计：完成 2 | 进行中 1        │
│                                     │
└─────────────────────────────────────┘
```

---

## 四、团队协作场景

### 场景 10: 任务指派与转交

**触发**: 在 Slack 中 `/assign 任务ID @同事`

**场景**:
```
用户："/assign 123 @王五"
Bot："已将『重构订单模块』指派给 @王五"
      "@王五 你有一个新任务：重构订单模块 [查看详情] [接受] [拒绝]"

王五点击 [接受]
Bot："@王五 已接受任务，当前任务更新进展..."
```

---

### 场景 11: 等待阻塞提醒相关人

**触发**: 任务标记为"等待中"

**实现**:
```
用户在系统中标记"等待 @张三 提供 API 文档"
→ Bot 私信 @张三："@yanke 在任务『对接物流接口』中等待你提供 API 文档 [查看任务] [快速回复]"
→ @张三 可以直接在私信中回复，自动记录为任务进展
```

---

### 场景 12: 群聊任务汇总

**触发**: 在群聊中发送 `/summary` 或定时推送

**返回**:
```
📊 本周任务汇总 (@yanke)

✅ 已完成 (5)
• 完成订单模块重构
• 修复 3 个 Bug
• ...

🔄 进行中 (2)
• 支付流程优化 (进度 60%)
• 技术文档编写 (进度 30%)

⏸️ 等待中 (1)
• 第三方接口对接 (等 @张三)

📈 本周工时：38h
```

---

## 五、智能场景

### 场景 13: 智能任务建议

**触发**: 定时分析（如每天下午 5 点）

**实现**:
```
LLM 分析今日消息和任务 → 识别遗漏 → 推送建议

Bot："🤔 今天你在 #客户支持 频道讨论了 3 次关于『退款流程』的问题，
      但我没有看到你创建了相关任务。
      要自动创建一个任务吗？ [创建任务] [忽略]"
```

---

### 场景 14: 每日晚报生成

**触发**: 定时（如晚上 6 点）或手动 `/daily`

**返回**:
```
📰 2024-04-15 工作日报

@yanke 今日工作总结：

✅ 完成任务 (3)
1. 重构订单模块
   • 耗时：5h
   • 产出：PR #234 [链接]
   • 关键进展：完成核心逻辑重构，单元测试覆盖 90%

2. 修复支付超时 Bug
   • 耗时：1.5h
   • 产出：PR #235 [链接]

3. 客户紧急需求评估
   • 耗时：1h
   • 产出：评估文档 [链接]

⏱️ 时间统计
• 有效工作：7.5h
• 会议：1h
• AFK：0.5h

📅 明日计划
• 继续 Code Review 反馈修改
• 准备周三技术分享

──────────────
[分享到 #日报 频道] [保存] [编辑]
```

---

### 场景 15: 周报自动生成

**触发**: 周五下午自动推送 `/weekly`

**返回周报结构**:
```
📊 第 16 周工作周报 (04-15 ~ 04-19)

🎯 本周重点项目进展

1. 【订单模块重构】(进度 80% → 100%)
   周一：完成方案设计评审
   周二-周三：核心逻辑重构
   周四：单元测试 + PR 提交
   周五：Code Review 通过，已合并
   
   关键产出：
   • PR #234 [链接]
   • 重构文档 [链接]
   
2. 【支付系统优化】(进度 20% → 60%)
   ...

📈 本周统计
• 完成任务：12 个
• 新增任务：8 个
• 总工时：40h (平均 8h/天)
• 代码产出：+2,345 -890 行

🚧 风险与阻塞
• 第三方物流 API 延迟，可能影响下周联调
  └─ 跟进人：@张三，预计解决：下周一

📅 下周计划
1. 支付系统优化收尾
2. 开始新需求『会员积分系统』
3. 周三技术分享：《订单重构经验》

──────────────
[复制文本] [生成 PDF] [发送到 #周报]
```

---

## 六、技术实现要点

### Webhook 配置

```javascript
// Slack Event API 配置
{
  "event": {
    "type": "message",
    "channel": "C1234567890",
    "user": "U1234567890",
    "text": "@yanke 帮忙看下这个",
    "ts": "1713153600.123456"
  }
}

// 处理逻辑
app.post('/slack/events', async (req, res) => {
  const { event } = req.body;
  
  // 1. 被 @mention 时创建任务
  if (event.type === 'message' && event.text.includes('<@U_MY_ID>')) {
    await createTaskFromMessage(event);
  }
  
  // 2. emoji reaction 处理
  if (event.type === 'reaction_added') {
    if (event.reaction === 'task') {
      await createTaskFromReaction(event);
    }
    if (event.reaction === 'white_check_mark') {
      await completeTaskFromReaction(event);
    }
  }
  
  res.status(200).send('OK');
});
```

### 斜杠命令配置

```javascript
// /tasks 命令
app.post('/slack/commands/tasks', async (req, res) => {
  const { text, user_id } = req.body;
  
  // 用 LLM 解析查询意图
  const query = await parseNaturalLanguage(text);
  const tasks = await taskService.query(user_id, query);
  
  res.json({
    response_type: 'ephemeral', // 仅用户可见
    blocks: formatTaskList(tasks)
  });
});

// /done 命令
app.post('/slack/commands/done', async (req, res) => {
  const { text, user_id, channel_id } = req.body;
  const taskId = parseTaskId(text);
  
  await taskService.complete(user_id, taskId);
  
  // 询问是否生成日报
  res.json({
    response_type: 'ephemeral',
    text: '✅ 任务已标记完成',
    attachments: [{
      text: '要生成今日日报吗？',
      actions: [
        { name: 'generate_daily', text: '生成日报', type: 'button' },
        { name: 'later', text: '稍后', type: 'button' }
      ]
    }]
  });
});
```

### 交互式组件

```javascript
// 按钮点击处理
app.post('/slack/interactive', async (req, res) => {
  const payload = JSON.parse(req.body.payload);
  const { actions, user, message } = payload;
  
  const action = actions[0];
  
  switch (action.name) {
    case 'start_task':
      await taskService.start(user.id, action.value);
      await updateMessage(message.ts, '任务已开始！');
      break;
      
    case 'mark_afk':
      await taskService.startAfk(user.id, action.value);
      break;
      
    case 'generate_daily':
      const report = await reportService.generateDaily(user.id);
      await postMessage(user.id, report);
      break;
  }
  
  res.status(200).send('');
});
```

---

## 七、场景优先级建议

### P0 (核心 MVP)
1. **场景 1**: 消息自动创建任务
2. **场景 7**: 自然语言查询任务
3. **场景 14**: 每日晚报生成

### P1 (增强体验)
4. **场景 2**: 进展快捷记录
5. **场景 4**: 每日晨会提醒
6. **场景 3**: 任务完成快捷确认

### P2 (进阶功能)
7. **场景 9**: 快捷操作面板
8. **场景 8**: 任务上下文追溯
9. **场景 15**: 周报自动生成

### P3 (团队协作)
10. **场景 10**: 任务指派与转交
11. **场景 11**: 等待阻塞提醒相关人
12. **场景 12**: 群聊任务汇总

### P4 (智能场景)
13. **场景 13**: 智能任务建议
14. **场景 6**: AFK 恢复提醒
15. **场景 5**: 任务状态变更通知
