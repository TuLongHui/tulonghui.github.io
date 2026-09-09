// remind-identity.cjs — 用 wx.login code 换 openid 并写入订阅文件的对应 userId
// 用法: node remind-identity.cjs <code> <userId>
// 环境变量: WX_APPID, WX_APP_SECRET
'use strict'
const fs = require('fs')
const https = require('https')

const CODE = process.argv[2] || ''
const USER_ID = process.argv[3] || ''
const APPID = process.env.WX_APPID || ''
const SECRET = process.env.WX_APP_SECRET || ''
const FILE = 'data/reminder-subscriptions.json'

if (!CODE || !USER_ID || !APPID || !SECRET) {
  console.error('missing args/env: code/userId/WX_APPID/WX_APP_SECRET')
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

;(async () => {
  const r = await get('https://api.weixin.qq.com/sns/jscode2session?appid=' + APPID +
    '&secret=' + SECRET + '&js_code=' + encodeURIComponent(CODE) + '&grant_type=authorization_code')
  console.log('jscode2session status', r.status)
  const data = JSON.parse(r.body)
  if (!data.openid) {
    console.error('no openid, errcode=' + data.errcode + ' errmsg=' + data.errmsg)
    process.exit(1)
  }
  // 读文件（可能不存在）
  let obj = { subscriptions: {} }
  try { obj = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch (e) {}
  if (!obj.subscriptions || typeof obj.subscriptions !== 'object') obj.subscriptions = {}
  if (!obj.subscriptions[USER_ID]) obj.subscriptions[USER_ID] = { v: 1 }
  obj.subscriptions[USER_ID].openId = data.openid
  obj.subscriptions[USER_ID].openIdTime = Date.now()
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2))
  console.log('openid bound to', USER_ID)
})().catch(e => { console.error(e); process.exit(1) })
