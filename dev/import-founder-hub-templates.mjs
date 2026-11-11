import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(process.argv[2] ?? '../shots-founder-hub')
const migration = 'crates/db-app/migrations/20260524000000_default_templates.sql'
const sql = await readFile(path.join(source, migration), 'utf8')
const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE templates(id TEXT PRIMARY KEY,title TEXT,description TEXT,pinned INTEGER,pin_order INTEGER,category TEXT,targets_json TEXT,sections_json TEXT)')
db.exec(sql)
const templates = db.prepare('SELECT * FROM templates ORDER BY id').all().map((row) => ({
  id: row.id,
  content: {
    title: row.title,
    description: row.description,
    category: row.category,
    icon: { type: 'icon', value: 'notebook-tabs', color: '#9ca3af' },
    targets: JSON.parse(row.targets_json),
    sections: JSON.parse(row.sections_json),
  },
}))
assert.equal(templates.length, 17)
assert(templates.every((template) => template.id.startsWith('default-') && template.content.sections.length))
await writeFile(path.join(root, 'server/internal/founderhub/default-templates.json'), JSON.stringify({ source: migration, sha256: createHash('sha256').update(sql).digest('hex'), templates }, null, 2) + '\n')
db.close()
console.log(`Imported ${templates.length} original default templates.`)
