// daily-reminder-push.cjs — 扫描订阅计划，向明天/当天到期的用户推送微信订阅消息
// 用法: node daily-reminder-push.cjs [push|check|test]
//   push  默认。北京时间18点定时任务：扫描并推送明天/当天到期节点
//   check 拉取小程序订阅消息模板列表及字段定义（校准 data 映射用）
//   test  给第一个已绑定 openid 的用户发一条测试推送
// 环境变量: WX_APPID, WX_APP_SECRET, WX_TEMPLATE_ID(可选，默认用内置模板ID)
'use strict'
const fs = require('fs')
const https = require('https')

const APPID = process.env.WX_APPID || ''
const SECRET = process.env.WX_APP_SECRET || ''
const GH_TOKEN = process.env.GH_TOKEN || ''  // 用于推送成功后回写 quota 扣减（可选）
const FILE = 'data/reminder-subscriptions.json'
const TEMPLATE_ID = process.env.WX_TEMPLATE_ID || 'VUYZLeb7KcZWttZmvQDZp40iBxg-7IK5mM00lWVLy0w'
const MODE = (process.argv[2] || 'push').toLowerCase()

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

// GitHub contents API：读文件（拿 sha + 内容）/ 写文件
function ghGet(path) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://api.github.com' + path)
    const req = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers: { 'Authorization': 'token ' + GH_TOKEN, 'Accept': 'application/vnd.github+json', 'User-Agent': 'reminder-bot' } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = b; try { j = JSON.parse(b) } catch (e) {}; resolve({ status: res.statusCode, body: j }) }) })
    req.on('error', reject); req.end()
  })
}
function ghPut(path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://api.github.com' + path)
    const payload = JSON.stringify(body)
    const req = https.request({ method: 'PUT', hostname: u.hostname, path: u.pathname + u.search, headers: { 'Authorization': 'token ' + GH_TOKEN, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'reminder-bot' } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = b; try { j = JSON.parse(b) } catch (e) {}; resolve({ status: res.statusCode, body: j }) }) })
    req.on('error', reject); req.write(payload); req.end()
  })
}

// 推送成功后回写 quota 扣减（记录本盘被消耗的授权次数）
async function deductQuota(consumed) {
  if (!GH_TOKEN || !consumed.length) return
  const apiPath = '/repos/TuLongHui/tulonghui.github.io/contents/' + FILE
  const g = await ghGet(apiPath + '?ref=main')
  if (g.status !== 200) { console.log('quota 回写失败：读文件 ' + g.status); return }
  let obj
  try { obj = JSON.parse(Buffer.from(g.body.content, 'base64').toString('utf8')) } catch (e) { console.log('quota 回写失败：解析'); return }
  for (const c of consumed) {
    const u = obj.subscriptions && obj.subscriptions[c.userId]
    if (u && typeof u.quota === 'number' && u.quota > 0) u.quota = Math.max(0, u.quota - c.count)
  }
  const p = await ghPut(apiPath, {
    message: 'deduct reminder quota: ' + consumed.map(c => c.userId + 'x' + c.count).join(', '),
    content: Buffer.from(JSON.stringify(obj, null, 2)).toString('base64'),
    sha: g.body.sha,
    branch: 'main'
  })
  console.log('quota 回写: ' + (p.status === 200 ? 'OK' : 'FAIL ' + p.status))
}

// 重建各用户的计划日期集（与客户端 buildFollowPlan/buildMedPlan 口径一致）
function buildDates(user) {
  const out = []
  const validStops = (Array.isArray(user.medStopRecords) ? user.medStopRecords : [])
    .map(s => ({ date: s.date, days: parseInt(s.days) || 0 }))
    .filter(s => s.date && s.days > 0)
  const addMonths = (ds, m) => {
    const p = ds.split('-').map(Number)
    return dateStr(new Date(p[0], p[1] - 1 + m, p[2]))
  }
  const addDays = (ds, days) => {
    const p = ds.split('-').map(Number)
    return dateStr(new Date(p[0], p[1] - 1, p[2] + days))
  }
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
      const arr = checks[fp] || checks
      const c = arr ? (arr[idx] ? 1 : 0) : 0
      out.push({ date: r, checked: !!c, source: 'follow' })
      idx++
    }
  }
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

function truncate(s, n) {
  s = String(s)
  let w = 0, out = ''
  for (const ch of s) {
    w += 1
    if (w > n) return out + '…'
    out += ch
  }
  return out
}

;(async () => {
  if (!APPID || !SECRET) { console.error('missing WX_APPID/WX_APP_SECRET'); process.exit(1) }

  // access_token
  const tk = await httpJson('GET', 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + APPID + '&secret=' + SECRET)
  if (!tk.data || !tk.data.access_token) {
    console.error('get access_token failed:', JSON.stringify(tk.data))
    process.exit(1)
  }
  const TOKEN = tk.data.access_token

  // ===== check 模式：打印模板与字段定义 =====
  if (MODE === 'check') {
    const tpl = await httpJson('GET', 'https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate?access_token=' + TOKEN)
    console.log('gettemplate errcode=' + tpl.data.errcode + ' ' + (tpl.data.errmsg || ''))
    if (tpl.data.errcode === 0 && Array.isArray(tpl.data.data)) {
      for (const t of tpl.data.data) {
        console.log('--- 模板: ' + t.title + ' | id=' + t.priTmplId)
        for (const f of (t.data || [])) {
          console.log('    ' + f.key + '  type=' + f.type + '  name=' + (f.name || ''))
        }
      }
      console.log('模板总数: ' + tpl.data.data.length)
    } else {
      console.log(JSON.stringify(tpl.data).slice(0, 600))
      process.exit(1)
    }
    process.exit(0)
  }

  // 读订阅文件
  let subs = {}
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    subs = obj.subscriptions || {}
  } catch (e) { console.log('no subscriptions file, nothing to do'); process.exit(0) }

  const today = dateStr(new Date())
  const tmr = dateStr(new Date(Date.now() + 86400000))
  let sent = 0, skipped = 0
  const consumed = []  // [{userId, count}] 用于推送成功后扣减 quota
  const seenOpenIds = {}  // v2.1.36 openid 去重：同一微信用户可能残留多个 userId 条目，只推一次

  for (const userId of Object.keys(subs)) {
    const user = subs[userId]
    if (!user || !user.openId) { skipped++; continue }
    // openid 去重：同一 openid 只处理第一个命中的条目
    if (seenOpenIds[user.openId]) { skipped++; continue }
    seenOpenIds[user.openId] = true

    // ===== test 模式：只发第一条测试消息 =====
    if (MODE === 'test') {
      const isEn = user.lang === 'en'
      const body = {
        touser: user.openId,
        template_id: TEMPLATE_ID,
        page: 'pages/index/index?category=discharge',
        data: {
          date1: { value: today },
          thing2: { value: truncate(isEn ? 'Test push' : '测试推送', 20) },
          thing3: { value: truncate(isEn ? 'Test, please ignore' : '测试推送，请忽略', 20) },
          thing4: { value: truncate(isEn ? 'Push channel works' : '推送链路已打通', 20) }
        }
      }
      const resp = await httpJson('POST', 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + TOKEN, body)
      const ok = resp.data && resp.data.errcode === 0
      console.log((ok ? 'TEST SENT' : 'TEST FAIL') + ' user=' + userId + (ok ? '' : ' err=' + JSON.stringify(resp.data)))
      process.exit(ok ? 0 : 2)
    }

    // ===== push 模式 =====
    let targets = []
    const fromItems = (items) => (items || [])
      .filter(it => it && it.r && !it.c)
      .map(it => ({ date: it.r, exam: it.e || '' }))
    targets = fromItems(user.followPlanItems).concat(fromItems(user.medPlanItems))
    if (!targets.length) {
      targets = buildDates(user).filter(t => !t.checked).map(t => ({ date: t.date, exam: '' }))
    }
    const due = targets.filter(t => t.date === today || t.date === tmr)
    if (!due.length) continue

    const isEn = user.lang === 'en'
    for (const d of due) {
      const examName = d.exam || (isEn ? 'Follow-up examination' : '复查检查')
      // 天数描述：与客户端横幅口径一致（明天/今天/已超期N天）
      const remain = d.date === tmr ? (isEn ? 'Due tomorrow' : '明天到期')
        : d.date === today ? (isEn ? 'Due today' : '今天到期')
        : d.date
      const note = isEn ? 'Please arrange the exam' : '请安排检查，详见小程序复查页'
      const body = {
        touser: user.openId,
        template_id: TEMPLATE_ID,
        page: 'pages/index/index?category=discharge',
        data: {
          date1: { value: d.date },
          thing2: { value: truncate(remain, 20) },
          thing3: { value: truncate(examName, 20) },
          thing4: { value: truncate(note, 20) }
        }
      }
      const resp = await httpJson('POST', 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + TOKEN, body)
      const ok = resp.data && resp.data.errcode === 0
      console.log((ok ? 'SENT' : 'FAIL') + ' user=' + userId + ' date=' + d.date + ' exam=' + examName +
        (ok ? '' : ' err=' + JSON.stringify(resp.data)))
      if (ok) {
        sent++
        // 记录本次消耗，推送完后统一回写扣减
        const rec = consumed.find(c => c.userId === userId)
        if (rec) rec.count++
        else consumed.push({ userId, count: 1 })
      }
    }
  }
  console.log('done. sent=' + sent + ' skippedNoOpenId=' + skipped)
  // v2.1.35 推送成功后扣减剩余次数（微信一次性订阅：每条消息消耗一次授权）
  await deductQuota(consumed)
})().catch(e => { console.error(e); process.exit(1) })
