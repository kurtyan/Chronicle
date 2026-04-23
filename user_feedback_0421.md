# 任务状态
- 增加onHold状态，含义：
  - 一些任务没完成，但要很久以后才做
  - 在任务列表界面，查看onHold状态的任务的筛选按钮，放在“已完成”右边，需要与“已完成”“废弃”一起收到new按钮旁的<小按钮中

- 任务列表中展示的任务，去掉删除按钮

- 废弃任务原因对话框，太丑了，需要改好看一点

# 任务展示 & 编辑
- 任务详情的展示
  - 富文本编辑框编辑富文本并提交后展示时 会把enter吞掉，但ctrl + enter不会被吞，需要修复
  - 当试图选中文字时，因为发生了鼠标点击，会进入编辑状态。需要改成：选中文字时，不进入编辑状态
- 附件
  - 富文本编辑器中允许拖入文件作为附件。附件的处理方式：
    - 文件copy到 ~/.chronicle/attachment/<taskId>/ ，为了防止文件名重复，加上时间戳作为前缀
    - 富文本编辑器中保留文件的样式，实际保存附件被copy后的本地存储位置
    - 在富文本展示时，如果点击附件，则在Finder中打开附件保存的位置


# task实体的修改
- 当编辑了task正文 / 编辑了task log正文 / 新建了task log时，需要更新task的updateTime为当前值
- 给task新增一个extra_info表，包含：task_id, key, value，用于未来更丰富地扩展
  - 给task增加pin功能
    - 在任务列表中某个task上单击右键，需要展示菜单，其中提供pin task的功能（对于已pin的task，需要提供unpin task功能）
    - task是否被pinned，在extra_info中保存。如果task被pinned，则key为‘is_pinned'， value为true，如果被unpin，删除key='is_pinned'的记录
    - 在任务列表上方，优先展示pinned task
  - 给task增加claude conversation功能
    - task_extra_info中增加 key = 'claude_conversaion_id', value是一个string，value内容是claude session的conversation_id
    - 所有task task_log相关的接口，在http header中加入一个X-Claude-Conversation功能。当claude调用接口时，会在这里传递conversationId。这些接口需要获取这个header，并保存在task的task_extra_info中。
    - task详情页的taskId右侧的复制按钮右侧展示一个 Claude 按钮。点击该按钮，打开terminal并运行
      - 当有conversation_id时：  cd ~/IdeaProjects && claude -r <claude_conversaion_id> 
      - 当没有conversation_id时： cd ~/IdeaProjects && claude 'chronicle taskId: <taskId>'

# UI展示
- Tauri目前展示的语种跟随了系统locale，需要在配置文件和setting界面中新增一个language选项，用来切换界面language

# 工时管理
- 当自动afk发生时，弹出一个对话框，其中上方展示label： AutoAFK: <00:00:00>(计时器), reason: ，中间展示一个text area，用来输入afk reason，下方展示提交按钮。注意：这个数据存到哪里，需要你分析方案与我讨论
- Report展示工作时长时，如果有正在take over的任务，此时计算工作时长用的endTime是endOfDay，这样有问题。需要改成：min(endOfDay, now)
- Report中的工作任务和工作时长的展示：
  - 目前在下方展示了工作时长和work session列表。实际上没人关心work session。
  - 需要把任务数统计与工作时长统计上下对调
  - 任务数统计中：
    - Total改为New
    - New、Completed、Inprogress、Overall Tasks都要做成可点击的
    - 下方列表中，展示当前选中时间段内某个类型的task，默认展示Completed
      - task按照updateTime倒序排列，需要展示  标题 创建时间 完成时间 工时（通过task关联的work session计算）
      - 当点击task时，在界面右侧叠加一层page，展示task的标题、正文、work logs
        - 按esc退出展示

