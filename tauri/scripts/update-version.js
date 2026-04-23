/**
 * Update Cargo.toml and tauri.conf.json version fields from VERSION_BUILD.
 * Run before tauri build.
 */
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const version = fs.readFileSync(join(root, '..', 'VERSION_BUILD'), 'utf-8').trim().replace(/^v/, '')

// Update Cargo.toml
const cargoPath = join(root, 'src-tauri/Cargo.toml')
let cargo = fs.readFileSync(cargoPath, 'utf-8')
cargo = cargo.replace(/^version = ".*"/m, `version = "${version}"`)
fs.writeFileSync(cargoPath, cargo)

// Update tauri.conf.json
const confPath = join(root, 'src-tauri/tauri.conf.json')
let conf = JSON.parse(fs.readFileSync(confPath, 'utf-8'))
conf.version = version
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n')
