// remind-identity.cjs — 用 wx.login code 换 openid 并写入订阅文件的对应 userId
// v2: 改为经 GitHub contents API 读远程数据（以远程为准合并保存），解决并发 workflow_dispatch
//     各自基于本地 checkout 提交导致 pull --rebase 冲突的问题；同 openid 重复绑定时清理旧条目，
//     保证 openid 唯一（同一微信用户只保留一个 userId 条目），避免推送重复。
// 用法: node remind-identity.cjs <code> <userId>
// 环境变量: WX_APPID, WX_APP_SECRET, GH_TOKEN
'use strict'
const https = require('https')

const CODE = process.argv[2] || ''
const USER_ID = process.argv[3] || ''
const APPID = process.env.WX_APPID || ''
const SECRET = process.env.WX_APP_SECRET || ''
const GH_TOKEN = process.env.GH_TOKEN || ''
const FILE = 'data/reminder-subscriptions.json'
const API = '/repos/TuLongHui/tulonghui.github.io/contents/' + FILE

if (!CODE || !USER_ID || !APPID || !SECRET || !GH_TOKEN) {
  console.error('missing args/env: code/userId/WX_APPID/WX_APP_SECRET/GH_TOKEN')
  process.exit(1)
}
if (CODE === 'SKIP_OPENID') { console.log('skip openid bind'); process.exit(0) }

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => resolve({ status: res.statusCode, body: buf }))
    }).on('error', reject)
  })
}

function ghJson(method, payload) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: 'api.github.com',
      path: API,
      headers: {
        'Authorization': 'token ' + GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'reminder-bot',
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

;(async () => {
  // 1. jscode2session 换 openid
  const r = await get('https://api.weixin.qq.com/sns/jscode2session?appid=' + APPID +
    '&secret=' + SECRET + '&js_code=' + encodeURIComponent(CODE) + '&grant_type=authorization_code')
  console.log('jscode2session status', r.status)
  const data = JSON.parse(r.body)
  if (!data.openid) {
    console.error('no openid, errcode=' + data.errcode + ' errmsg=' + data.errmsg)
    process.exit(1)
  }
  const openid = data.openid

  // 2. 读-改-写循环（以远程为准合并，PUT 带 sha 原子覆盖；冲突/失败重试 3 次）
  let ok = false
  let removed = []
  for (let i = 0; i < 3; i++) {
    // 2a. 拉远程最新数据
    const g = await ghJson('GET')
    let sha = ''
    let obj = { subscriptions: {} }
    if (g.status === 200 && g.body && g.body.content) {
      sha = g.body.sha
      try { obj = JSON.parse(Buffer.from(g.body.content, 'base64').toString('utf8')) } catch (e) { obj = { subscriptions: {} } }
    } else if (g.status !== 404) {
      console.log('get attempt ' + (i + 1) + ' status ' + g.status + ', retry')
      await sleep(1500)
      continue
    }
    if (!obj.subscriptions || typeof obj.subscriptions !== 'object') obj.subscriptions = {}

    // 2b. 绑定 openid 到本次 userId，并清理同 openid 的其他条目（openid 唯一原则）。
    // 合并策略：旧条目里有而本次条目没有的字段先拷入，再删除（避免丢计划数据）
    if (!obj.subscriptions[USER_ID] || typeof obj.subscriptions[USER_ID] !== 'object') obj.subscriptions[USER_ID] = { v: 1 }
    const removedNow = []
    for (const uid of Object.keys(obj.subscriptions)) {
      if (uid === USER_ID) continue
      const old = obj.subscriptions[uid]
      if (old && old.openId === openid) {
        removedNow.push(uid)
        for (const k of Object.keys(old)) {
          if (k === 'openId' || k === 'openIdTime' || obj.subscriptions[USER_ID][k] !== undefined) continue
          obj.subscriptions[USER_ID][k] = old[k]
        }
        if (typeof old.quota === 'number') {
          obj.subscriptions[USER_ID].quota = Math.max(obj.subscriptions[USER_ID].quota || 0, old.quota)
        }
        delete obj.subscriptions[uid]
      }
    }
    obj.subscriptions[USER_ID].openId = openid
    obj.subscriptions[USER_ID].openIdTime = Date.now()

    // 2c. 写回
    const p = await ghJson('PUT', JSON.stringify({
      message: 'bind openid ' + USER_ID + (removedNow.length ? ' (dedup: ' + removedNow.join(',') + ')' : ''),
      content: Buffer.from(JSON.stringify(obj, null, 2)).toString('base64'),
      sha: sha || undefined,
      branch: 'main'
    }))
    if (p.status === 200 || p.status === 201) { ok = true; removed = removedNow; break }
    console.log('put attempt ' + (i + 1) + ' status ' + p.status + ', refetch and retry')
    await sleep(1500)
  }
  if (!ok) { console.error('commit binding failed after retries'); process.exit(1) }
  console.log('openid bound to ' + USER_ID + (removed.length ? ', removed duplicate: ' + removed.join(',') : ''))
})().catch(e => { console.error(e); process.exit(1) })
