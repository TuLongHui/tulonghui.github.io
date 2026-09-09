// daily-reminder-push.cjs — 扫描订阅计划，向明天/当天到期的用户推送微信订阅消息
// 环境变量: WX_APPID, WX_APP_SECRET
// 数据文件: data/reminder-subscriptions.json
// 结构: { subscriptions: { [userId]: { lang, surgeryDate, medDate, medCycle,
//   followPlanChecks, medPlanChecks, medStopRecords,
//   followPlanItems: [{m,r,e,c}], medPlanItems: [{m,r,e,c}], openId, openIdTime, updateTime } } }
'use strict'
const fs = require('fs')
const https = require('https')

const APPID = process.env.WX_APPID || ''
const SECRET = process.env.WX_APP_SECRET || ''
const FILE = 'data/reminder-subscriptions.json'

function httpJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const opts = { method, hostname: u.hostname, path: u.pathname + u.search, headers: {} }
    let payload = null
    if (body !== undefined) {
      payload = JSON.stringify(body)
      opts.headers['Content-Type'] = 'application/json'
      opts.headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = https.request(opts, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }) }
        catch (e) { resolve({ status: res.statusCode, data: buf }) }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function pad(n) { return String(n).padStart(2, '0') }
function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }

// 重建各用户的计划日期集（与客户端 buildFollowPlan/buildMedPlan 口径一致）
function buildDates(user) {
  const out = [] // { date, exam, source }
  const validStops = (Array.isArray(user.medStopRecords) ? user.medStopRecords : [])
    .map(s => ({ date: s.date, days: parseInt(s.days) || 0 }))
    .filter(s => s.date && s.days > 0)
  const addMonths = (ds, m) => {
    const p = ds.split('-').map(Number)
    const dt = new Date(p[0], p[1] - 1 + m, p[2])
    return dateStr(dt)
  }
  const addDays = (ds, days) => {
    const p = ds.split('-').map(Number)
    const dt = new Date(p[0], p[1] - 1, p[2] + days)
    return dateStr(dt)
  }
  // 手术复查计划：跟客户端 items 完全一致（含勾选状态）
  if (user.surgeryDate) {
    const fp = user.followPeriod || '0-5'
    const months = []
    if (fp === '0-5') { for (let m = 3; m <= 24; m += 3) months.push(m); for (let m = 30; m <= 60; m += 6) months.push(m) }
    else if (fp === '5-15') { for (let m = 66; m <= 120; m += 6) months.push(m); for (let m = 132; m <= 180; m += 12) months.push(m) }
    else if (fp === '15-25') { for (let m = 192; m <= 300; m += 12) months.push(m) }
    else if (fp === '25-35') { for (let m = 312; m <= 420; m += 12) months.push(m) }
    const checks = user.followPlanChecks || {}
    let idx = 0
    for (const m of months) {
      const r = addMonths(user.surgeryDate, m)
      const c = checks[fp] ? (checks[fp][idx] ? 1 : 0) : (user.followPlanChecks ? (user.followPlanChecks[idx] ? 1 : 0) : 0)
      out.push({ date: r, checked: !!c, source: 'follow' })
      idx++
    }
  }
  // 服药复查计划：首查1个月，之后每3个月直到 medCycle；停药顺延
  if (user.medDate) {
    const cycle = user.medCycle || 12
    const months = [1]
    for (let m = 4; m <= cycle; m += 3) months.push(m)
    const checks = user.medPlanChecks || {}
    months.forEach((m, i) => {
      const base = addMonths(user.medDate, m)
      let extra = 0
      for (const s of validStops) { if (base >= s.date) extra += s.days }
      const r = extra > 0 ? addDays(base, extra) : base
      out.push({ date: r, checked: !!checks[i], source: 'med' })
    })
  }
  return out
}

;(async () => {
  if (!APPID || !SECRET) { console.error('missing WX_APPID/WX_APP_SECRET'); process.exit(1) }

  // 读订阅文件
  let subs = {}
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    subs = obj.subscriptions || {}
  } catch (e) { console.log('no subscriptions file, nothing to do'); process.exit(0) }

  // access_token
  const tk = await httpJson('GET', 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + APPID + '&secret=' + SECRET)
  if (!tk.data || !tk.data.access_token) {
    console.error('get access_token failed:', JSON.stringify(tk.data))
    process.exit(1)
  }
  const TOKEN = tk.data.access_token

  const today = dateStr(new Date())
  const tmr = dateStr(new Date(Date.now() + 86400000))
  let sent = 0, skipped = 0

  for (const userId of Object.keys(subs)) {
    const user = subs[userId]
    if (!user || !user.openId) { skipped++; continue }
    // 优先用客户端上报的计划项（含检查名称），缺失则后端重建
    let targets = []
    const fromItems = (items) => (items || [])
      .filter(it => it && it.r && !it.c)
      .map(it => ({ date: it.r, exam: it.e || '', source: '' }))
    targets = fromItems(user.followPlanItems).concat(fromItems(user.medPlanItems))
    if (!targets.length) {
      targets = buildDates(user).filter(t => !t.checked).map(t => ({ date: t.date, exam: '', source: t.source }))
    }
    const due = targets.filter(t => t.date === today || t.date === tmr)
    if (!due.length) continue

    const isEn = user.lang === 'en'
    for (const d of due) {
      const examName = d.exam || (isEn ? 'Follow-up examination' : '复查检查')
      const when = d.date === today ? (isEn ? 'today' : '今天') : (isEn ? 'tomorrow' : '明天')
      const page = 'pages/index/index?category=discharge'
      const body = {
        touser: user.openId,
        template_id: process.env.WX_TEMPLATE_ID || '',
        page: page,
        data: {
          thing1: { value: truncate(examName, 20) },
          thing2: { value: truncate(isEn ? 'DFSP follow-up reminder' : 'DFSP复查提醒', 20) },
          time3: { value: d.date },
          thing4: { value: truncate(isEn ? 'Due ' + when : when + '到期，请安排检查', 20) }
        }
      }
      if (!body.template_id) { console.log('no template id set, skip all'); process.exit(0) }
      const resp = await httpJson('POST', 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + TOKEN, body)
      const ok = resp.data && resp.data.errcode === 0
      console.log((ok ? 'SENT' : 'FAIL') + ' user=' + userId + ' date=' + d.date + ' exam=' + examName +
        (ok ? '' : ' err=' + JSON.stringify(resp.data)))
      if (ok) sent++
    }
  }
  console.log('done. sent=' + sent + ' skippedNoOpenId=' + skipped)
})().catch(e => { console.error(e); process.exit(1) })

function truncate(s, n) {
  // 微信订阅消息 thing 参数最长 20 字符（1个中文算1个）
  s = String(s)
  let w = 0, out = ''
  for (const ch of s) {
    w += 1
    if (w > n) return out + '…'
    out += ch
  }
  return out
}
