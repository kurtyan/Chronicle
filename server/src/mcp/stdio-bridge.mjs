#!/usr/bin/env node
/**
 * Stdio MCP server for Chronicle.
 * Bridges Claude Code (stdio) → Chronicle HTTP API.
 *
 * Usage: node stdio-bridge.mjs [--base-url http://127.0.0.1:9983]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'

import fs from 'fs'
import path from 'path'
import os from 'os'

function loadConfig() {
  try {
    const configPath = path.join(os.homedir(), '.chronicle', 'config.json')
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const { host, port } = parsed?.server ?? {}
      return { host: host ?? '127.0.0.1', port: port ?? 9983 }
    }
  } catch {}
  return { host: '127.0.0.1', port: 9983 }
}

const config = loadConfig()
const baseUrl = (() => {
  const idx = process.argv.indexOf('--base-url')
  if (idx >= 0) return process.argv[idx + 1]
  return `http://${config.host}:${config.port}`
})()

async function api(path, options = {}) {
  const url = `${baseUrl}${path}`
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json()
}

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
    description: 'Query tasks with optional type/status filters.',
    inputSchema: {
      status: z.string().optional().describe('Comma-separated status filter, e.g. "PENDING,DOING".'),
      type: z.string().optional().describe('Task type: TODO, TOREAD, or DAILY_IMPROVE.'),
    },
  },
  async ({ status, type }) => {
    const params = new URLSearchParams()
    if (type) params.set('type', type)
    if (status) params.set('status', status)
    const tasks = await api(`/api/tasks?${params}`)
    return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] }
  }
)

server.registerTool(
  'get_task',
  {
    description: 'Get a task by ID along with its log entries.',
    inputSchema: {
      taskId: z.string().describe('The task ID, e.g. "T0000000001".'),
    },
  },
  async ({ taskId }) => {
    const task = await api(`/api/tasks/${taskId}`)
    if (task.error) return { content: [{ type: 'text', text: `Task "${taskId}" not found.` }], isError: true }
    const logs = await api(`/api/tasks/${taskId}/logs`)
    return { content: [{ type: 'text', text: JSON.stringify({ task, logs }, null, 2) }] }
  }
)

server.registerTool(
  'query_sessions',
  {
    description: 'Query work sessions within a time range (unix timestamps, ms).',
    inputSchema: {
      startTimestamp: z.number().describe('Start of time range (ms).'),
      endTimestamp: z.number().describe('End of time range (ms).'),
    },
  },
  async ({ startTimestamp, endTimestamp }) => {
    const sessions = await api(`/api/sessions?start=${startTimestamp}&end=${endTimestamp}`)
    return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] }
  }
)

server.registerTool(
  'takeover_task',
  {
    description: 'Take over a task: reads history, returns summary, marks DOING, starts session.',
    inputSchema: {
      taskId: z.string().describe('The task ID to take over.'),
    },
  },
  async ({ taskId }) => {
    const task = await api(`/api/tasks/${taskId}`)
    if (task.error) return { content: [{ type: 'text', text: `Task "${taskId}" not found.` }], isError: true }
    const logs = await api(`/api/tasks/${taskId}/logs`)
    const session = await api(`/api/tasks/${taskId}/takeover`, { method: 'POST' })

    const logSummary = logs.length > 0
      ? logs.map(l => `[${new Date(l.createdAt).toISOString()}] [${l.type}] ${l.content}`).join('\n')
      : 'No logs yet.'

    return {
      content: [{
        type: 'text',
        text: [
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
        ].join('\n'),
      }],
    }
  }
)

server.registerTool(
  'create_task',
  {
    description: 'Create a new task.',
    inputSchema: {
      title: z.string().describe('Task title.'),
      type: z.string().optional().describe('Task type: TODO, TOREAD, or DAILY_IMPROVE. Default: TODO.'),
      priority: z.string().optional().describe('Priority: HIGH, MEDIUM, or LOW. Default: MEDIUM.'),
      tags: z.array(z.string()).optional().describe('Optional tags.'),
      dueDate: z.number().optional().describe('Optional due date (unix timestamp, ms).'),
    },
  },
  async ({ title, type, priority, tags, dueDate }) => {
    const task = await api('/api/tasks', {
      method: 'POST',
      body: { title, type: type ?? 'TODO', priority: priority ?? 'MEDIUM', tags, dueDate },
    })
    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] }
  }
)

server.registerTool(
  'update_task_status',
  {
    description: "Update a task's status: PENDING, DOING, DONE, DROPPED.",
    inputSchema: {
      taskId: z.string().describe('The task ID.'),
      status: z.string().describe('New status: PENDING, DOING, DONE, or DROPPED.'),
    },
  },
  async ({ taskId, status }) => {
    const task = await api(`/api/tasks/${taskId}`, {
      method: 'PUT',
      body: { status },
    })
    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] }
  }
)

server.registerTool(
  'add_log',
  {
    description: 'Add a log entry to a task.',
    inputSchema: {
      taskId: z.string().describe('The task ID.'),
      content: z.string().describe('Log content.'),
      type: z.string().optional().describe('Entry type: "log" or "body". Default: log.'),
    },
  },
  async ({ taskId, content, type }) => {
    const entry = await api(`/api/tasks/${taskId}/logs`, {
      method: 'POST',
      body: { content, type: type ?? 'log' },
    })
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] }
  }
)

server.registerTool(
  'search_tasks',
  {
    description: 'Full-text search across tasks and logs (FTS5 + jieba).',
    inputSchema: {
      query: z.string().describe('Search query text.'),
      limit: z.number().optional().describe('Maximum results. Default: 50.'),
    },
  },
  async ({ query, limit }) => {
    const result = await api(`/api/search?q=${encodeURIComponent(query)}&limit=${limit ?? 50}`)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('Chronicle MCP stdio server started')
