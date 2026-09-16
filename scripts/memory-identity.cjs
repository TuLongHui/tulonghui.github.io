// memory-identity.cjs — 记忆功能服务端（v2.2.35 明文直传）：memory-bind / memory-lookup
// memory-lookup: wx.login code → openid → 指纹 → 在 data/user-backups.json 匹配备份 → 写 data/memory-lookup-result.json
//                命中返回 payload 明文（v2 旧 rec 密文条目回退返回 rec，由客户端兼容处理）
// memory-bind:   wx.login code → openid → 指纹 → 把指纹绑到客户端 userId 条目（换机恢复后归并，必要时从同指纹旧条目复制 rec/payload）
// 安全设计：云端不落明文 openid（只存 SHA-256 前 12 位指纹）；payload 本身明文（用户 2026-09-15 决策：去加密，修手机端卡死）
// 用法: node memory-identity.cjs <memory-bind|memory-lookup> <code> [userId] [requestId]
// 环境变量: WX_APPID, WX_APP_SECRET, GH_TOKEN
'use strict'
const https = require('https')
const crypto = require('crypto')

const EVENT = process.argv[2] || ''
const CODE = process.argv[3] || ''
const USER_ID = process.argv[4] || ''
const REQUEST_ID = process.argv[5] || ''
const APPID = process.env.WX_APPID || ''
const SECRET = process.env.WX_APP_SECRET || ''
const GH_TOKEN = process.env.GH_TOKEN || ''

const BACKUPS_FILE = 'data/user-backups.json'
const RESULT_FILE = 'data/memory-lookup-result.json'
const SUBS_FILE = 'data/reminder-subscriptions.json' // remind-identity 用（推送需明文 openid，历史设计如此）
const API_BASE = '/repos/TuLongHui/tulonghui.github.io/contents/'
const RESULT_TTL_MS = 30 * 60 * 1000 // 查询结果保留 30 分钟

// openid → 12 位指纹（与客户端 utils/backup-crypto.js 的 fingerprint 同算法）
function fpOf(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 12)
}

// 在 backups 中找 openId 指纹匹配的最新条目（同指纹多条目取 rec/payload 时间最大者）
function pickEntryForOpenid(backups, fp) {
  let best = null
  let bestTs = -1
  const map = backups || {}
  for (const uid of Object.keys(map)) {
    const entry = map[uid]
    if (!entry || entry.openId !== fp) continue
    // v2 明文条目取 payload.time；v1 旧密文条目取 rec.ts
    const ts = (entry.payload && typeof entry.payload.time === 'number' && entry.payload.time) ||
               (entry.rec && typeof entry.rec.ts === 'number' && entry.rec.ts) || 0
    if (ts > bestTs) { best = entry; bestTs = ts }
  }
  return best
}

// 清理过期查询结果（原地删除），返回是否有变更
function pruneResults(results, now, maxAgeMs) {
  let changed = false
  const map = results || {}
  for (const rid of Object.keys(map)) {
    const r = map[rid]
    if (!r || typeof r.ts !== 'number' || now - r.ts > maxAgeMs) {
      delete map[rid]
      changed = true
    }
  }
  return changed
}

// ---------- 网络 ----------
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => resolve({ status: res.statusCode, body: buf }))
    }).on('error', reject)
  })
}

function ghJson(method, path, payload) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: 'api.github.com',
      path: API_BASE + path,
      headers: {
        'Authorization': 'token ' + GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'memory-bot',
        'Content-Length': Buffer.byteLength(payload || '')
      }
    }
    const req = https.request(opts, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => { let j = null; try { j = JSON.parse(buf) } catch (e) {} ; resolve({ status: res.statusCode, body: j }) })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)) }

// 读-改-写循环写单个文件（409/422 sha 冲突重试 3 次）
async function rmw(path, mutate, commitMsg) {
  for (let i = 0; i < 3; i++) {
    const g = await ghJson('GET', path)
    let sha = ''
    let obj = {}
    if (g.status === 200 && g.body && g.body.content) {
      sha = g.body.sha
      try { obj = JSON.parse(Buffer.from(g.body.content, 'base64').toString('utf8')) || {} } catch (e) { obj = {} }
    } else if (g.status !== 404) {
      console.log('get ' + path + ' attempt ' + (i + 1) + ' status ' + g.status + ', retry')
      await sleep(1500)
      continue
    }
    mutate(obj)
    const p = await ghJson('PUT', path, JSON.stringify({
      message: commitMsg,
      content: Buffer.from(JSON.stringify(obj)).toString('base64'),
      sha: sha || undefined,
      branch: 'main'
    }))
    if (p.status === 200 || p.status === 201) return true
    console.log('put ' + path + ' attempt ' + (i + 1) + ' status ' + p.status + ', refetch and retry')
    await sleep(1500)
  }
  return false
}

;(async () => {
  if ((EVENT !== 'memory-bind' && EVENT !== 'memory-lookup' && EVENT !== 'remind-identity') || !CODE || !APPID || !SECRET || !GH_TOKEN) {
    console.error('usage: node memory-identity.cjs <memory-bind|memory-lookup|remind-identity> <code> [userId] [requestId]  (env: WX_APPID/WX_APP_SECRET/GH_TOKEN)')
    process.exit(1)
  }
  // remind-identity 断链修复：客户端 v2.2.33 起统一走 repository_dispatch（原 workflow_dispatch 通道不可用），
  // 转发到既有 remind-identity.cjs 逻辑（同 openid 唯一化合并写入订阅文件）
  if (EVENT === 'remind-identity') {
    if (!USER_ID) { console.error('remind-identity missing userId'); process.exit(1) }
    const { execFile } = require('child_process')
    const path = require('path')
    await new Promise((resolve) => {
      execFile('node', [path.join(__dirname, 'remind-identity.cjs'), CODE, USER_ID], {
        env: { WX_APPID: APPID, WX_APP_SECRET: SECRET, GH_TOKEN: GH_TOKEN }
      }, (err, stdout, stderr) => {
        if (err) { console.error('remind-identity sub-run failed:', stderr || err.message) ; process.exitCode = 1 }
        else { console.log(stdout.trim()) }
        resolve()
      })
    })
    process.exit(process.exitCode || 0)
  }

  // 1. jscode2session 换 openid
  const r = await get('https://api.weixin.qq.com/sns/jscode2session?appid=' + APPID +
    '&secret=' + SECRET + '&js_code=' + encodeURIComponent(CODE) + '&grant_type=authorization_code')
  console.log('jscode2session status', r.status)
  let data = {}
  try { data = JSON.parse(r.body) } catch (e) {}
  if (!data.openid) {
    console.error('no openid, errcode=' + data.errcode + ' errmsg=' + data.errmsg)
    // lookup 必须落结果（客户端在轮询等待），bind 直接失败退出即可
    if (EVENT === 'memory-lookup' && REQUEST_ID) {
      const ok = await rmw(RESULT_FILE, (obj) => {
        if (!obj.results || typeof obj.results !== 'object') obj.results = {}
        obj.results[REQUEST_ID] = { found: false, error: 'openid-fail', ts: Date.now() }
      }, 'memory-lookup openid-fail ' + new Date().toISOString().slice(0, 10))
      console.log('lookup failure result written: ' + ok)
    }
    process.exit(1)
  }
  const fp = fpOf(data.openid)

  if (EVENT === 'memory-lookup') {
    if (!REQUEST_ID) { console.error('missing requestId'); process.exit(1) }
    // 2. 读备份文件 → 按指纹匹配
    const g = await ghJson('GET', BACKUPS_FILE)
    let backups = {}
    if (g.status === 200 && g.body && g.body.content) {
      try { backups = (JSON.parse(Buffer.from(g.body.content, 'base64').toString('utf8')) || {}).backups || {} } catch (e) { backups = {} }
    }
    const entry = pickEntryForOpenid(backups, fp)
    const hitPayload = entry && entry.payload ? entry.payload : null
    const hitRec = entry && entry.rec ? entry.rec : null
    // 3. 写查询结果（顺带清理 30 分钟前旧结果）；v2 明文→payload，v1 旧密文→rec（客户端兼容）
    const ok = await rmw(RESULT_FILE, (obj) => {
      if (!obj.results || typeof obj.results !== 'object') obj.results = {}
      pruneResults(obj.results, Date.now(), RESULT_TTL_MS)
      obj.results[REQUEST_ID] = entry
        ? { found: true, ...(hitPayload ? { payload: hitPayload } : { rec: hitRec }), ts: Date.now() }
        : { found: false, ts: Date.now() }
    }, 'memory-lookup ' + (entry ? 'hit' : 'miss') + ' ' + new Date().toISOString().slice(0, 10))
    if (!ok) { console.error('write lookup result failed'); process.exit(1) }
    console.log('lookup ' + REQUEST_ID + ' -> ' + (entry ? (hitPayload ? 'HIT v2 (payload ts ' + hitPayload.time + ')' : 'HIT v1 (rec ts ' + hitRec.ts + ')') : 'MISS'))
    process.exit(0)
  }

  // memory-bind
  if (!USER_ID) { console.error('missing userId'); process.exit(1) }
  let ok = false
  for (let i = 0; i < 3 && !ok; i++) {
    const g = await ghJson('GET', BACKUPS_FILE)
    let sha = ''
    let obj = {}
    if (g.status === 200 && g.body && g.body.content) {
      sha = g.body.sha
      try { obj = JSON.parse(Buffer.from(g.body.content, 'base64').toString('utf8')) || {} } catch (e) { obj = {} }
    } else if (g.status !== 404) {
      console.log('get attempt ' + (i + 1) + ' status ' + g.status + ', retry')
      await sleep(1500)
      continue
    }
    if (!obj.backups || typeof obj.backups !== 'object') obj.backups = {}
    let action = 'touched'
    if (!obj.backups[USER_ID] || typeof obj.backups[USER_ID] !== 'object') {
      // 本机新条目不存在：从同指纹旧条目复制 payload/rec（换机恢复后首次绑定），否则建空壳
      const oldEntry = pickEntryForOpenid(obj.backups, fp)
      if (oldEntry) {
        obj.backups[USER_ID] = { v: oldEntry.v || 2, openId: fp, openIdTime: Date.now() }
        if (oldEntry.payload) obj.backups[USER_ID].payload = oldEntry.payload
        if (oldEntry.rec) obj.backups[USER_ID].rec = oldEntry.rec
        action = 'copied-' + (oldEntry.payload ? 'payload' : 'rec')
      } else {
        obj.backups[USER_ID] = { v: 2, openId: fp, openIdTime: Date.now() }
      }
    } else {
      // 条目已存在（恢复后可能已自动备份过）：仅补指纹
      obj.backups[USER_ID].openId = fp
      obj.backups[USER_ID].openIdTime = Date.now()
    }
    const p = await ghJson('PUT', BACKUPS_FILE, JSON.stringify({
      message: 'memory-bind ' + USER_ID + ' (' + action + ') ' + new Date().toISOString().slice(0, 10),
      content: Buffer.from(JSON.stringify(obj)).toString('base64'),
      sha: sha || undefined,
      branch: 'main'
    }))
    if (p.status === 200 || p.status === 201) { ok = true; console.log('bound ' + USER_ID + ' -> fp ' + fp + ' (' + action + ')') }
    else { console.log('put attempt ' + (i + 1) + ' status ' + p.status + ', refetch and retry'); await sleep(1500) }
  }
  if (!ok) { console.error('memory-bind failed after retries'); process.exit(1) }
})().catch(e => { console.error(e); process.exit(1) })
