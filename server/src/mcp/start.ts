import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { AppService } from '../services/appService'
import { searchTasks } from '../services/searchService'
import type { IncomingMessage, ServerResponse } from 'http'
import * as z from 'zod/v4'

function createMcpServer(service: AppService): McpServer {
  const server = new McpServer(
    { name: 'chronicle', version: '1.0.0' },
    {
      instructions:
        'Chronicle is a local-first task management system. Use these tools to query and manage tasks, work sessions, and logs.',
    }
  )

  server.registerTool(
    'query_tasks',
    {
      description:
        'Query tasks with optional status/type filters. Returns tasks sorted by updated_at descending.',
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(
            'Comma-separated status values to filter by (e.g. "PENDING,DOING"). Omit to return all.'
          ),
        type: z
          .string()
          .optional()
          .describe('Task type filter: TODO, TOREAD, or DAILY_IMPROVE.'),
      },
    },
    async ({ status, type }): Promise<CallToolResult> => {
      const tasks = await service.fetchTodos(type, status)
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] }
    }
  )

  server.registerTool(
    'get_task',
    {
      description:
        'Get a task by ID along with its log entries.',
      inputSchema: {
        taskId: z.string().describe('The task ID, e.g. "T0000000001".'),
      },
    },
    async ({ taskId }): Promise<CallToolResult> => {
      const task = await service.getTaskById(taskId)
      if (!task) {
        return {
          content: [{ type: 'text', text: `Task "${taskId}" not found.` }],
          isError: true,
        }
      }
      const logs = await service.fetchTaskEntries(taskId)
      return {
        content: [{ type: 'text', text: JSON.stringify({ task, logs }, null, 2) }],
      }
    }
  )

  server.registerTool(
    'query_sessions',
    {
      description:
        'Query work sessions within a time range. Use unix timestamps (milliseconds).',
      inputSchema: {
        startTimestamp: z
          .number()
          .describe('Start of time range (unix timestamp, ms).'),
        endTimestamp: z
          .number()
          .describe('End of time range (unix timestamp, ms).'),
      },
    },
    async ({ startTimestamp, endTimestamp }): Promise<CallToolResult> => {
      const sessions = await service.fetchSessions(startTimestamp, endTimestamp)
      return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] }
    }
  )

  server.registerTool(
    'takeover_task',
    {
      description:
        'Take over a task: reads its history/logs, returns a summary, and marks the task as DOING (starts a work session).',
      inputSchema: {
        taskId: z.string().describe('The task ID to take over.'),
      },
    },
    async ({ taskId }): Promise<CallToolResult> => {
      const task = await service.getTaskById(taskId)
      if (!task) {
        return {
          content: [{ type: 'text', text: `Task "${taskId}" not found.` }],
          isError: true,
        }
      }
      const logs = await service.fetchTaskEntries(taskId)
      const { session } = await service.takeOverTask(taskId)

      const logSummary =
        logs.length > 0
          ? logs
              .map(
                (l) =>
                  `[${new Date(l.createdAt).toISOString()}] [${l.type}] ${l.content}`
              )
              .join('\n')
          : 'No logs yet.'

      const summary = [
        `Task: ${task.title}`,
        `ID: ${task.id}`,
        `Type: ${task.type}`,
        `Priority: ${task.priority}`,
        `Status: ${task.status} → DOING`,
        `Created: ${new Date(task.createdAt).toISOString()}`,
        '',
        '--- Logs ---',
        logSummary,
        '',
        `Session started at: ${new Date(session.startedAt).toISOString()}`,
      ].join('\n')

      return { content: [{ type: 'text', text: summary }] }
    }
  )

  server.registerTool(
    'create_task',
    {
      description: 'Create a new task.',
      inputSchema: {
        title: z.string().describe('Task title.'),
        type: z
          .string()
          .optional()
          .describe('Task type: TODO, TOREAD, or DAILY_IMPROVE. Default: TODO.'),
        priority: z
          .string()
          .optional()
          .describe('Priority: HIGH, MEDIUM, or LOW. Default: MEDIUM.'),
        tags: z.array(z.string()).optional().describe('Optional tags.'),
        dueDate: z
          .number()
          .optional()
          .describe('Optional due date (unix timestamp, ms).'),
      },
    },
    async ({ title, type, priority, tags, dueDate }): Promise<CallToolResult> => {
      const task = await service.createTask({
        title,
        type: type ?? 'TODO',
        priority: priority ?? 'MEDIUM',
        tags,
        dueDate,
      })
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] }
    }
  )

  server.registerTool(
    'update_task_status',
    {
      description:
        "Update a task's status. Valid values: PENDING, DOING, DONE, DROPPED.",
      inputSchema: {
        taskId: z.string().describe('The task ID.'),
        status: z
          .string()
          .describe('New status: PENDING, DOING, DONE, or DROPPED.'),
      },
    },
    async ({ taskId, status }): Promise<CallToolResult> => {
      const task = await service.updateTask(taskId, { status })
      if (!task) {
        return {
          content: [{ type: 'text', text: `Task "${taskId}" not found.` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] }
    }
  )

  server.registerTool(
    'add_log',
    {
      description:
        'Add a log entry to a task. Use this to record progress, notes, or decisions.',
      inputSchema: {
        taskId: z.string().describe('The task ID.'),
        content: z.string().describe('Log content.'),
        type: z
          .string()
          .optional()
          .describe(
            'Entry type: "log" for brief notes, "body" for detailed content. Default: log.'
          ),
      },
    },
    async ({ taskId, content, type }): Promise<CallToolResult> => {
      try {
        const entry = await service.submitTaskEntry(
          taskId,
          content,
          (type as 'log' | 'body') ?? 'log'
        )
        return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }], isError: true }
      }
    }
  )

  server.registerTool(
    'search_tasks',
    {
      description:
        'Full-text search across tasks and their log entries. Uses FTS5 + jieba for Chinese/English tokenization.',
      inputSchema: {
        query: z.string().describe('Search query text.'),
        limit: z
          .number()
          .optional()
          .describe('Maximum results. Default: 50, max: 200.'),
      },
    },
    async ({ query, limit }): Promise<CallToolResult> => {
      const result = searchTasks(query, Math.min(limit ?? 50, 200))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  return server
}

export function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: AppService
): Promise<void> {
  const server = createMcpServer(service)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  })

  return server.connect(transport).then(() => {
    return transport.handleRequest(req, res)
  }).catch((err) => {
    console.error('MCP transport error:', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      }))
    }
  })
}
