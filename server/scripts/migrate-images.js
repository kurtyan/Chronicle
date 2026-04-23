#!/usr/bin/env node
/**
 * Migrate existing base64 images in task_entries.content to filesystem storage.
 *
 * For each base64 image found in the database:
 * 1. Decode and save the image to ~/.chronicle/attachment/{taskId}/{ts}_{hash}.{ext}
 * 2. Replace src="data:image/..." with src="" data-fullpath="/absolute/path"
 *
 * Usage: node server/scripts/migrate-images.js [db-path]
 *   db-path defaults to the configured database path
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

// Resolve database path
const dbPath = process.argv[2] || process.env.CHRONICLE_DB_PATH || path.join(process.cwd(), 'data', 'tasks.db')

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`)
  process.exit(1)
}

const Database = require('better-sqlite3')
const db = new Database(dbPath, { readonly: false })

// Get attachment directory
const attachmentDir = process.env.CHRONICLE_ATTACHMENT_DIR || path.join(os.homedir(), '.chronicle', 'attachment')

console.log(`Database: ${dbPath}`)
console.log(`Attachment dir: ${attachmentDir}`)
console.log('')

// Find all task_entries
const rows = db.prepare('SELECT id, task_id, content FROM task_entries WHERE content LIKE ?').all('%data:image/%')

console.log(`Found ${rows.length} entries containing base64 images`)
console.log('')

let totalImages = 0
let savedImages = 0
let updatedEntries = 0

for (const row of rows) {
  let content = row.content

  // Collect all matches first, then replace (avoids lastIndex bug when modifying string during iteration)
  const imgRegex = /<img\b[^>]*src="(data:image\/[^"]+)"[^>]*>/gi
  const matches = [...content.matchAll(imgRegex)]

  if (matches.length === 0) continue

  for (const match of matches) {
    totalImages++
    const dataUri = match[1]
    const fullTag = match[0]

    // Decode base64 data
    const mimeMatch = dataUri.match(/^data:(image\/\w+);base64,(.+)$/)
    if (!mimeMatch) continue

    const mimeType = mimeMatch[1]
    const base64Data = mimeMatch[2]

    let buffer
    try {
      buffer = Buffer.from(base64Data, 'base64')
    } catch {
      console.error(`  Failed to decode image in entry ${row.id}`)
      continue
    }

    // Determine file extension
    const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : mimeType === 'image/gif' ? 'gif' : mimeType === 'image/webp' ? 'webp' : 'png'

    // Generate filename
    const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 12)
    const ts = Date.now()
    const fileName = `${ts}_${hash}.${ext}`

    // Save to filesystem
    const taskDir = path.join(attachmentDir, row.task_id)
    fs.mkdirSync(taskDir, { recursive: true })
    const filePath = path.join(taskDir, fileName)
    fs.writeFileSync(filePath, buffer)
    savedImages++

    // Replace the <img> tag: empty src + data-fullpath + data-filename
    const newTag = fullTag
      .replace(/src="data:image\/[^"]+"/, `src="" data-fullpath="${filePath}"`)
    const finalTag = newTag.includes('data-filename=')
      ? newTag
      : newTag.replace(/<img\b/, `<img data-filename="${fileName}"`)
    content = content.replace(fullTag, finalTag)

    console.log(`  Entry ${row.id}: saved ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`)
  }

  if (savedImages > 0) {
    db.prepare('UPDATE task_entries SET content = ? WHERE id = ?').run(content, row.id)
    updatedEntries++
  }
}

db.close()

console.log('')
console.log(`Done. Total entries scanned: ${rows.length}`)
console.log(`Total images found: ${totalImages}`)
console.log(`Images saved to filesystem: ${savedImages}`)
console.log(`Entries updated: ${updatedEntries}`)
