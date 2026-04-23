# A requirement doc for llm integration.

## Use cases (currently implemented by customized skill)
- I will copy taskId from chronicle and in claude code conversation I will tell it 'chronicle taskId: <the copied taskId>', claude code will remember this taskId in session context. The taskId will still be persisted even if claude code compacts the conversation  
- I will tell claude code to 'send xxx to chronicle', claude code will call chronicle's append task log api with previously remembed 'chronicle taskId'  
- I will tell claude code to 'summarize today / yesterday / this week' work, claude code will call 'get work session' and 'get task' api, then analyze the whole time range's works (with default time offset +5h) and afk and give me result: afk analyze, task and task log analyze


## Requirements  
- I want to connect claude code and chronicle more easier, so,
  - chronicle task should remember claude code conversationId. This is previous supported in our infrastructure 'X-Claude-Conversation-Id', you need to write a skill to tell claude code 'each time when you send request to chronicle, you should get current conversationId (find by matching current pid in sessions.json) and attach it in http header X-Claude-Conversation-Id 
  - when clicking 'claude' button in task, Chronicle should open terminal and invoke claude -r <conversationId> (previously supported)
  - when initially click 'claude' button in task, Chronicle will open terminal and invoke claude 'chronicle taskId: <the taskId>', you should write skill to tell claude code to 'just remember this chronicle taskId in context, don't do any query/operation to chronicle. even if the claude conversation got compacted, you should still keep the chronicle taskId'
  - in this bi-notificate way, claude code's conversation and chronicle task can be bound together.  
- I want you to write preset skills on 'send xxx to chronicle's task log' 'summarize xx day's work'  
- I want you to write a prompt to tell claude code how to install these preset skills
- In future release the skills might get updated, so, I need you to design a version mechanism for the skills, after each release fo the skills, claude code can recognize new skills or updated skills from the new version and update installed skills to latest version  
