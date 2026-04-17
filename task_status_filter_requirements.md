# 关于任务状态的阐述、关于任务列表的需求、关于我每天关注的任务的需求

## 任务状态阐述
- 任务的状态流转：新建任务 -> 开始任务 -> 完成任务
- 已开始的任务可能有很多个，因此才会有take over和AFK的概念
- 任务分为 未开始 已开始，是为了我肉眼更好地区分工作内容


## 任务列表的需求
- 我不会经常查看已完成或者已废弃的任务，因此：
  - 从任务列表顶层筛选栏去掉 Active / Done / Dropped
  - new按钮要扩展一下，成为 一个大的new按钮 + 一个小的左箭头(<)的按钮
    - 主按钮：仍然是new功能
    - 左箭头按钮按下后，把 new + < 向左滑动展开成三个同等大小的按钮： new done dropped，且只展示这三个按钮，移除其他所有已有按钮
    - 点击 done 后，done被选中，在列表中展示Done的任务
      - 此时再次点击done (或者cmd + w快捷键)，则取消选中done，任务列表恢复为点击done之前的样子。同时延迟1s后滑动收起三个按钮，恢复成 new + < 以及恢复任务列表其他筛选按钮
    - 点击 drop 后，drop被选中，在列表中展示Dropped的任务
      - 此时再次点击drop (或者cmd + w快捷键)，则取消选中done，任务列表恢复为点击drop之前的样子。同时延迟1s后滑动收起三个按钮，恢复成 new + < 以及恢复任务列表其他筛选按钮
- Task / To Read / Daily Improve三个改为多选状态
  - 全都不选中的情况下，按修改时间倒序展示所有非done和非dropped的任务
  - 选中一个或多个的情况下，按照已选中的进行筛选、不包括done和dropped，按修改时间倒序排列
- 额外增加一个Today按钮
  - Today的选中 与 (Task / To Read / Daily Improve)互斥
  - Today取消选中，则恢复选中前的 (Task / To Read / Daily Improve) 任务
  - 快捷键 cmd + t用来toggle Today的选中和不选中。注意，此处按快捷键选中或者取消选中后，需要按照上面两条规则联动 (Task / To Read / Daily Improve)  的不选中和选中
  - 选中Today后，任务列表展示如下组合：
    - 当前所有未完成高优先级任务
    - 1条最早的 未完成也未Drop的daily improvement
    - 1条最早的 未完成也未Drop的To Read
  - 为了便于你理解需求：Today是为了我每天能更早看到当天高优先级任务


- 任务的 Pending / In progress的自动变迁：
  - 任务创建后，不要自动take over，保持在pending状态
  - 任务take over后，自动进入In progress状态
  - 任务afk后，不改变其状态

- 任务列表中任务的展示
  - 目前有基于颜色区分的优先级 和 标题
  - 需要增加：
    - 在最右侧展示任务创建的时间
      - 1周以内创建的，显示 x days ago 或者 Today
        - 鼠标移过去后，展示详细日期时间
      - 1周一前创建的，显示详细日期时间
