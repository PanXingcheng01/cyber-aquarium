'use strict'

/**
 * ASCII 赛博鱼缸 —— 主进程
 * 窗口：无边框 / 透明 / 置顶 / 不进任务栏 —— 屏幕上只有字符本身。
 * 拖动：窗口跟着鼠标走（主进程按屏幕光标位置重定位），所以拖动和"点一下喂食"靠 4px 位移阈值区分，
 *       跟 dsh-whale-widget 的 drag.moved 判定是同一套思路。 */
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const LAYOUT = {
  cols: 55,
  rows: 22,
  sizes: {
    small: { cellW: 6, cellH: 11, pad: 11 },
    medium: { cellW: 7, cellH: 13, pad: 12 },
    large: { cellW: 9, cellH: 17, pad: 14 },
  },
}

const DEFAULT_STATE = {
  x: null,
  y: null,
  size: 'medium',
  theme: 'clear',
  // 第一次启动（没有 state.json）时给 4：刚好跌破 5，鱼一出来就是"饿坏了"（头顶 ! 、底栏闪红）
  // 之后就全听存档的，不会再重置
  satiety: 4,
  fishCount: 3,
  fish: [], // 每条鱼的种类/颜色 profile；旧存档没有，启动时按 fishCount 兼容
  alwaysOnTop: true,
  savedAt: Date.now(),
}

let win = null
let state = { ...DEFAULT_STATE }
let dragTimer = null
let dragOffset = null

const captureArg = process.argv.find((a) => a.startsWith('--capture='))
const wantMenu = process.argv.includes('--menu')
const wantFeed = process.argv.includes('--feed')
const wantProbe = process.argv.includes('--probe')
const wantSelfTest = process.argv.includes('--selftest')
const wantFps = process.argv.includes('--fps')
const waitArg = process.argv.find((a) => a.startsWith('--wait='))
const sizeArg = process.argv.find((a) => a.startsWith('--size='))

// ---------------------------------------------------------------- 布局 / 持久化
function layoutFor(name) {
  const s = LAYOUT.sizes[name] || LAYOUT.sizes.medium
  return {
    cols: LAYOUT.cols,
    rows: LAYOUT.rows,
    cellW: s.cellW,
    cellH: s.cellH,
    pad: s.pad,
    width: LAYOUT.cols * s.cellW + s.pad * 2,
    height: LAYOUT.rows * s.cellH + s.pad * 2,
  }
}

function statePath() {
  return path.join(app.getPath('userData'), 'state.json')
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') state = { ...DEFAULT_STATE, ...parsed }
  } catch (err) {
  // 首次运行没有存档：用默认值
  }
}

function saveState() {
  try {
    const file = statePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    state.savedAt = Date.now()
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
  // 存档失败不影响挂件运行
  }
}

// ---------------------------------------------------------------- 屏幕几何

function workAreaFor(x, y, w, h) {
  const cx = Math.round(x + w / 2)
  const cy = Math.round(y + h / 2)
  const display = screen.getDisplayNearestPoint({ x: cx, y: cy })
  return display.workArea
}

function clampToScreen(x, y, w, h) {
  const wa = workAreaFor(x, y, w, h)
  return {
    x: Math.min(Math.max(Math.round(x), wa.x), wa.x + wa.width - w),
    y: Math.min(Math.max(Math.round(y), wa.y), wa.y + wa.height - h),
  }
}
/* clampToScreen 现在只留给尺寸自检用，正常摆放走 keepOnScreen */

function placeWindow(w, h) {
  if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
    return keepOnScreen(state.x, state.y, w, h)
  }
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - w - 28, y: wa.y + wa.height - h - 28 }
}

/** 松手后不吸附：只要保证至少 KEEP_VISIBLE 像素还留在屏幕里，随便放哪都行 */
const KEEP_VISIBLE = 48

function keepOnScreen(x, y, w, h) {
  const wa = workAreaFor(x, y, w, h)
  return {
    x: Math.min(Math.max(Math.round(x), wa.x - w + KEEP_VISIBLE), wa.x + wa.width - KEEP_VISIBLE),
    y: Math.min(Math.max(Math.round(y), wa.y - h + KEEP_VISIBLE), wa.y + wa.height - KEEP_VISIBLE),
  }
}

// ---------------------------------------------------------------- 拖动

/**
 * 拖动时必须**每一步都带上尺寸**（setBounds），不能用 setPosition：
 * 在 175% 缩放的显示器上，setPosition 每调一次窗口就长 1~2px（Electron 的
 * DIP↔物理像素取整累积），10ms 一步就是每秒 100~200px —— 透明外壳看不出来，
 * 深色外壳就是"背景一层越拖越大，鱼缸不变"。带上 width/height 每步写死就稳住了。
 * 代价：resizable:false 的窗口会忽略尺寸，所以要临时放开（跟 applyWindowSize 同一套）。
 */
let dragSize = null

function stopDrag() {
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = null
  dragOffset = null
  dragSize = null
  if (win && !win.isDestroyed()) win.setResizable(false)
}

function startDrag() {
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  const layout = layoutFor(state.size)
  const cursor = screen.getCursorScreenPoint()
  dragOffset = { x: cursor.x - b.x, y: cursor.y - b.y }
  dragSize = { width: layout.width, height: layout.height }
  stopDragTimerOnly()
  win.setResizable(true)
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !dragOffset || !dragSize) return
    const p = screen.getCursorScreenPoint()
    win.setBounds({
      x: Math.round(p.x - dragOffset.x),
      y: Math.round(p.y - dragOffset.y),
      width: dragSize.width,
      height: dragSize.height,
    })
  }, 10)
}

function stopDragTimerOnly() {
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = null
}

/** 松手收尾：不吸附，只保证还看得见；顺手把被 DPI 取整弄歪的尺寸写正 */
function finishDrag() {
  stopDrag()
  if (!win || win.isDestroyed()) return null
  const layout = layoutFor(state.size)
  const b = win.getBounds()
  const next = keepOnScreen(b.x, b.y, layout.width, layout.height)
  win.setResizable(true)
  win.setBounds({ x: next.x, y: next.y, width: layout.width, height: layout.height })
  win.setResizable(false)
  const final = win.getBounds()
  state.x = final.x
  state.y = final.y
  saveState()
  return final
}

// ---------------------------------------------------------------- 窗口

function createWindow() {
  const layout = layoutFor(state.size)
  const pos = placeWindow(layout.width, layout.height)

  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: layout.width,
    height: layout.height,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: !!state.alwaysOnTop,
    backgroundColor: '#00000000',
    show: false,
    title: '赛博鱼缸',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      backgroundThrottling: false,
    },
  })

  win.setMenu(null)
  if (state.alwaysOnTop) win.setAlwaysOnTop(true, 'floating')
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  win.once('ready-to-show', () => {
    win.showInactive()
    if (process.argv.includes('--sizetest')) runSizeTest()
    else if (process.argv.includes('--snaptest')) runSnapTest()
    else {
      if (sizeArg) {
        // 走渲染层自己的 applySize，布局和窗口一起改
        const name = sizeArg.slice('--size='.length)
        win.webContents.executeJavaScript(`window.__aq && window.__aq.setSize(${JSON.stringify(name)})`)
      }
      if (captureArg) runCapture(captureArg.slice('--capture='.length))
    }
  })

  win.on('closed', () => {
    stopDrag()
    win = null
  })
}

/** 吸附自检：靠边不吸附，但至少保留 KEEP_VISIBLE 像素可见 */
async function runSnapTest() {
  const out = {}
  try {
    await wait(500)
    const b = win.getBounds()
    const wa = screen.getPrimaryDisplay().workArea

    // 1) 离右边 10px：不应该被吸到边上
    win.setBounds({ x: wa.x + wa.width - b.width - 10, y: wa.y + 200, width: b.width, height: b.height })
    await wait(250)
    const before = win.getBounds()
    finishDrag()
    await wait(200)
    const after = win.getBounds()
    out.beforeX = before.x
    out.afterX = after.x
    out.noSnapOnEdge = before.x === after.x

    // 2) 拖到主屏左边界之外：只留 48px 可见（右边界可能连着第二块屏，不能用它测）
    win.setBounds({ x: wa.x - b.width + 20, y: wa.y + 200, width: b.width, height: b.height })
    await wait(250)
    const far = win.getBounds()
    out.farX = far.x
    finishDrag()
    await wait(200)
    const back = win.getBounds()
    out.backX = back.x
    out.keptVisible = back.x === wa.x - b.width + KEEP_VISIBLE
    console.log('snaptest ' + JSON.stringify(out))
  } catch (err) {
    console.error('snaptest failed: ' + (err && err.message))
  } finally {
    app.quit()
  }
}

/** 尺寸自检：走真实路径改三档，核对窗口 bounds 和页面可视区是否一致 */
async function runSizeTest() {
  try {
    await wait(600)
    const out = { steps: [] }
    for (const name of ['large', 'small', 'medium']) {
      const lay = applyWindowSize(name)
      await wait(450)
      const b = win.getBounds()
      const client = await win.webContents.executeJavaScript(
        '({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })',
      )
      out.steps.push({
        name,
        want: [lay.width, lay.height],
        window: [b.width, b.height],
        client: [client.w, client.h],
        match: b.width === lay.width && b.height === lay.height && client.w === lay.width,
      })
    }
    out.resizableFlag = win.isResizable()

    // 贴右下角后改尺寸：那条边应该还贴着
    const wa = screen.getPrimaryDisplay().workArea
    const m = layoutFor('medium')
    win.setResizable(true)
    win.setBounds({ x: wa.x + wa.width - m.width, y: wa.y + wa.height - m.height, width: m.width, height: m.height })
    win.setResizable(false)
    await wait(300)
    applyWindowSize('small')
    await wait(400)
    const nb = win.getBounds()
    out.anchor = {
      rightGap: wa.x + wa.width - (nb.x + nb.width),
      bottomGap: wa.y + wa.height - (nb.y + nb.height),
    }
    console.log('sizetest ' + JSON.stringify(out))
  } catch (err) {
    console.error('sizetest failed: ' + (err && err.message))
  } finally {
    app.quit()
  }
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 截图自检：--capture=<png 路径>（透明像素会以 alpha 保留） */
async function runCapture(target) {
  try {
    await wait(700)
    if (waitArg) await wait(Math.min(60000, Number(waitArg.slice('--wait='.length)) || 0))
    if (wantProbe) {
      const info = await win.webContents.executeJavaScript('JSON.stringify(window.__aq.metrics())')
      console.log('probe ' + info)
    }
    if (wantFps) {
      const res = await win.webContents.executeJavaScript(`(async () => {
        const M = window.__aq.model
        const cv = document.getElementById('tank')
        const sample = async (ms) => {
          const p0 = M.stats.paints
          const t0 = performance.now()
          await new Promise((r) => setTimeout(r, ms))
          return +( (M.stats.paints - p0) / ((performance.now() - t0) / 1000) ).toFixed(1)
        }
        const withGlow = await sample(1500)
        cv.style.filter = 'none'
        const noGlow = await sample(1500)
        cv.style.filter = ''
        return JSON.stringify({ withGlow, noGlow, paintMs: +(M.stats.paintMs || 0).toFixed(1) })
      })()`)
      console.log('fps ' + res)
    }
    if (process.argv.includes('--dump')) {
      const grid = await win.webContents.executeJavaScript('window.__aq.dump()')
      console.log('grid\n' + grid)
      const fish = await win.webContents.executeJavaScript(
        'JSON.stringify(window.__aq.model.fish.map(f => ({ body: f.body, x: +f.x.toFixed(1), y: +f.y.toFixed(1), dir: f.dir, mode: f.mode, modeT: +f.modeT.toFixed(1) })))',
      )
      console.log('fish ' + fish)
      const pellets = await win.webContents.executeJavaScript(
        'JSON.stringify(window.__aq.model.pellets.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })))',
      )
      console.log('pellets ' + pellets)
    }
    if (wantSelfTest) {
      const res = await win.webContents.executeJavaScript(`(async () => { try {
        const cv = document.getElementById('tank')
        const M = window.__aq.model
        const mk = (type, x, y, sx, sy) => new PointerEvent(type, {
          clientX: x, clientY: y, screenX: sx, screenY: sy, button: 0,
          buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
          pointerId: 7, pointerType: 'mouse', isPrimary: true,
        })
        const before = M.pellets.length
        // 先把鱼赶走，否则点到鱼身上会变成"戳"，测不出喂食
        M.fish.forEach((f, i) => { f.x = 42 + i * 3; f.y = 16 })
        cv.dispatchEvent(mk('pointerdown', 150, 120, 500, 400))
        cv.dispatchEvent(mk('pointerup', 150, 120, 500, 400))
        const afterClick = M.pellets.length
        cv.dispatchEvent(mk('pointerdown', 200, 160, 600, 300))
        cv.dispatchEvent(mk('pointermove', 240, 180, 640, 320))
        const dragStarts = M.stats.dragStarts
        cv.dispatchEvent(mk('pointerup', 240, 180, 640, 320))
        await new Promise((r) => setTimeout(r, 150))
        const menuAfterDrag = M.menuOpen
        cv.dispatchEvent(new MouseEvent('contextmenu', { clientX: 210, clientY: 170, bubbles: true, cancelable: true }))
        const menuAfterRightClick = M.menuOpen
        const menuItems = document.querySelectorAll('#menu button').length
        // 真实右键会先发 pointerdown 再发 contextmenu；只发 contextmenu 测不出
        // "捕获阶段先 closeMenu、contextmenu 又 open" 这个 bug
        cv.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: 210, clientY: 170, button: 2, buttons: 2,
          bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
        }))
        cv.dispatchEvent(new MouseEvent('contextmenu', { clientX: 210, clientY: 170, bubbles: true, cancelable: true }))
        const menuAfterSecondRightClick = M.menuOpen

        // 小丑鱼保底：首条一定是它，捞鱼不会把它捞走（要在改性格之前测）
        const hasClown = M.fish.length > 0 && M.fish[0].temper === 'clown'
        const clownRef = M.fish[0]
        window.__aq.addFish()
        window.__aq.runAction('remove')
        const clownKept = M.fish.includes(clownRef)

        // 三种性格对鼠标的反应：清掉鱼食（有食在会优先追食，测不出来）
        M.pellets.length = 0
        const lay = window.__aq.layout()
        const toPx = (c, r) => ({ x: lay.pad + (c + 0.5) * lay.cellW, y: lay.pad + (r + 0.5) * lay.cellH })
        const setCursor = (c, r, ageSec) => {
          M.cursor.x = c
          M.cursor.y = r
          M.cursor.inside = true
          M.cursor.stamp = M.t - (ageSec || 0)
        }
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const resetFishTestState = (x) => {
          x.bumpT = 0
          x.bumpCool = 0
          x.petT = 0
          x.petCool = 0
          x.falling = false
          x.outT = 0
          x.exciteT = 0
          x.returning = false
          x.fullT = 0
        }
        const isolateFishTest = (target) => {
          M.pellets.length = 0
          M.fish.forEach((x, i) => {
            resetFishTestState(x)
            if (x === target) return
            x.x = 3 + i * 4
            x.y = 2.5
            x.mode = 'cruise'
            x.modeT = 99
            x.scare = 0
          })
        }

        // 1) 胆小型：靠太近会加速逃开（用确定性步进，不依赖 rAF）
        const shy = M.fish[0]
        isolateFishTest(shy)
        shy.temper = 'shy'
        shy.mode = 'cruise'
        shy.modeT = 9
        shy.scare = 0
        shy.x = 20
        shy.y = 8
        setCursor(19, 8, 0)
        const shyX0 = shy.x
        window.__aq.stepSim(20)
        const shyFled = shy.x - shyX0 > 1

        // 胆小鱼受惊可以游出缸外消失，惊吓结束后再从墙边游回来
        const shyNormalMax = COLS - shy.body.length
        shy.x = shyNormalMax
        shy.y = 8
        shy.mode = 'cruise'
        shy.modeT = 9
        shy.bumpT = 0
        shy.bumpCool = 0
        shy.petT = 0
        shy.scare = 1.1
        shy.dir = 1 // 当前朝右，受惊时往右墙冲
        shy.returning = false
        let shyWentOut = false
        for (let k = 0; k < 20; k++) {
          window.__aq.stepSim(1)
          if (shy.x >= COLS) {
            shyWentOut = true
            break
          }
        }
        window.__aq.stepSim(45)
        const shyWallExit = shyWentOut && !shy.returning && shy.x >= 0 && shy.x <= shyNormalMax
        shy.x = 20
        shy.y = 8
        shy.scare = 0
        shy.returning = false
        shy.mode = 'cruise'
        shy.modeT = 9

        // 2) 好奇型：光标停住一会儿，它会绕过来
        const curious = M.fish[1]
        isolateFishTest(curious)
        curious.temper = 'still'
        curious.mode = 'cruise'
        curious.modeT = 9
        curious.scare = 0
        curious.x = 20
        curious.y = 8
        setCursor(14, 8, 3)
        const d0 = Math.hypot(curious.x, curious.y - 8)
        window.__aq.stepSim(45)
        const d1 = Math.hypot(curious.x, curious.y - 8)
        const stillApproached = d1 < d0 - 2

        // 3) 被动型：只跟正在移动的光标


        const calm = M.fish[2]
        isolateFishTest(calm)
        calm.temper = 'calm'
        calm.mode = 'cruise'
        calm.modeT = 9
        calm.scare = 0
        calm.x = 26
        calm.y = 8
        setCursor(24, 8, 0)
        const calmX0 = calm.x
        window.__aq.stepSim(9) // 0.6 秒：仍在"光标刚动过"的窗口内
        const calmFollowed = calmX0 - calm.x > 0.3

        // 点鱼身上 → 惊走，且不投食
        const paints0 = M.pellets.length
        const fp = toPx(Math.round(shy.x) + 1, Math.round(shy.y))
        window.__aq.clickAt(fp.x, fp.y)
        const scares = M.stats.scares
        const fedOnFish = M.pellets.length - paints0
        const scared = shy.scare > 0

        // 气泡应该从鱼嘴（行进方向最前面那个字符）出
        const mouthRight = window.__aq.mouthOf({ dir: 1, x: 10, body: '><>' })
        const mouthLeft = window.__aq.mouthOf({ dir: -1, x: 10, body: '><>' })
        const mouthOk = mouthRight === 12 && mouthLeft === 10

        // 吃食测试前把其它鱼赶远：鱼食现在有"认领"，别人抢了就先吃不到
        const isolateEater = (eater) => {
          M.fish.forEach((x, i) => {
            x.bumpT = 0
            x.bumpCool = 0
            x.scare = 0
            x.petT = 0
            if (x === eater) return
            x.x = 3 + i * 5
            x.y = 2.5
            x.mode = 'cruise'
            x.modeT = 30
          })
          M.cursor.inside = false // 别让鼠标性格插手
          M.crab.x = 46 // 螃蟹挪远，免得鱼贴它触发"让一让"
          M.crab.mode = 'wander'
          M.crab.modeT = 99
          M.pellets.length = 0
        }
        // 吃食逻辑：落在沙面上的鱼食也要吃得到（鱼最低只到 18.8，食在 19.65）
        M.satiety = 10 // 饿极了：食欲判定的硬规则，必吃
        const eater = M.fish[0]
        isolateEater(eater)
        eater.x = 20
        eater.y = 17.5
        eater.mode = 'cruise'
        eater.scare = 0
        M.pellets.length = 0
        M.pellets.push({ x: 22.5, y: 19.65, vy: 0, age: 0, settled: true })
        const satA = M.satiety
        window.__aq.stepSim(40)
        const ateSettled = M.pellets.length === 0 && M.satiety > satA



        // 深色外壳可以来回切（不假定起始是哪种，切两次要回到原样）
        const theme0 = M.theme
        window.__aq.runAction('theme')
        const theme1 = M.theme
        window.__aq.runAction('theme')
        const theme2 = M.theme
        const themeOk = theme1 !== theme0 && theme2 === theme0

        // ---- 螃蟹 ----
        const crab = M.crab
        const crabY0 = crab.y
        // 点它 → 夹人，这一下不投食
        M.pellets.length = 0
        const feeds0 = M.stats.feeds
        const pinches0 = M.stats.pinches
        const crabPx = toPx(Math.round(crab.x) + 3, Math.round(crab.y))
        window.__aq.clickAt(crabPx.x, crabPx.y)
        const crabPinched = crab.pinch > 0 && M.stats.pinches === pinches0 + 1 && M.stats.feeds === feeds0 && M.pellets.length === 0

        // 不吃鱼食：鱼食就摆在它脚边，几十帧后一颗不少（先把鱼喂饱，免得鱼来抢）
        const satBackup = M.satiety
        M.satiety = 100
        M.pellets.length = 0
        M.pellets.push({ x: Math.round(crab.x) + 3, y: 19.65, vy: 0, age: 0, settled: true })
        window.__aq.stepSim(60)
        const crabIgnoredFood = M.pellets.length === 1
        const crabStillOnSand = crab.y === crabY0
        M.pellets.length = 0
        M.satiety = satBackup

        // 跟随 / 躲开：两个方向都得对
        const setCrabCursor = (c) => {
          M.cursor.x = c
          M.cursor.y = Math.round(crab.y)
          M.cursor.inside = true
          M.cursor.stamp = M.t
        }
        // 先把鱼赶到上层：螃蟹测试不该被"让一让"打断
        M.fish.forEach((f, i) => { f.x = 4 + i * 6; f.y = 4; f.mode = 'cruise'; f.modeT = 99; f.scare = 0 })
        crab.x = 30
        crab.mode = 'chase'
        crab.modeT = 99
        crab.pinch = 0
        setCrabCursor(4)
        const chaseX0 = crab.x
        window.__aq.stepSim(15)
        const crabChased = crab.x < chaseX0 - 0.5

        crab.x = 10
        crab.mode = 'flee'
        crab.modeT = 99
        setCrabCursor(6)
        const fleeX0 = crab.x
        window.__aq.stepSim(15)
        const crabFled = crab.x > fleeX0 + 0.5
        crab.mode = 'wander'
        crab.modeT = 3

        // 睡着的时候：蹲下一格、脚收起来、钳子合上
        crab.mode = 'sleep'
        crab.modeT = 30
        crab.pinch = 0
        window.__aq.stepSim(1)
        window.__aq.repaint()
        const gridRows = window.__aq.dump().split('\\n')
        const crabCol = Math.round(crab.x)
        const shellRowSleep = (gridRows[Math.round(crab.y) + 1] || '').slice(crabCol, crabCol + 9)
        const feetRowSleep = (gridRows[Math.round(crab.y) + 2] || '').slice(crabCol, crabCol + 9)
        const clawRowSleep = (gridRows[Math.round(crab.y)] || '').slice(crabCol, crabCol + 9)
        const crabSleptCrouched = shellRowSleep.includes('_^_')
        const crabSleptNoFeet = !feetRowSleep.includes('v') && !feetRowSleep.includes("'")
        const crabSleptClaws = clawRowSleep.includes('>') && clawRowSleep.includes('<')

        // 别的鱼贴脸凑过来 → 会让一下（yields 计数 +1）
        crab.mode = 'wander'
        crab.modeT = 99
        const yields0 = M.stats.yields
        for (const f of M.fish.slice(0, 3)) {
          f.y = 18
          f.x = Math.round(crab.x) + (Math.random() < 0.5 ? -3 : 3)
          f.mode = 'cruise'
          f.modeT = 99
        }
        window.__aq.stepSim(60)
        const crabYielded = M.stats.yields > yields0

        const clownFish = M.fish.find((f) => f.paint === 'clown') || M.fish[0]
        let clownBackedOff = false
        let clownCameBack = false
        if (clownFish) {
          const clownTemper = clownFish.temper
          clownFish.temper = 'clown'
          // 把其它鱼和螃蟹都定住，别让随机溜达/碰撞干扰"逗螃蟹"判定
          M.pellets.length = 0
          M.fish.forEach((x, i) => {
            x.bumpT = 0
            x.bumpCool = 0
            x.petT = 0
            x.falling = false
            x.outT = 0
            x.exciteT = 0
            if (x === clownFish) return
            x.x = 3 + i * 4
            x.y = 2.5
            x.mode = 'cruise'
            x.modeT = 99
            x.scare = 0
          })
          clownFish.bumpT = 0
          clownFish.bumpCool = 0
          clownFish.petT = 0
          clownFish.falling = false
          clownFish.outT = 0
          clownFish.exciteT = 0
          // 固定螃蟹位置，避免它之前被溜达到左边导致测试鱼被放到负坐标
          crab.x = 30
          crab.y = 18
          crab.mode = 'sleep'
          crab.modeT = 999
          crab.pinch = 0
          crab.yTarget = 18
          crab.rowT = 999
          const near = Math.round(crab.x) + 4
          const aim = (c) => {
            M.cursor.x = c
            M.cursor.y = Math.round(crab.y)
            M.cursor.inside = true
            M.cursor.stamp = M.t
          }
          const gapOf = () => Math.abs(clownFish.x + clownFish.body.length / 2 - M.cursor.x)

          // 光标贴在螃蟹上 → 小丑鱼待在原处不过来
          aim(near)
          clownFish.x = near - 12
          clownFish.y = 10
          clownFish.mode = 'idle'
          clownFish.modeT = 99
          clownFish.scare = 0
          window.__aq.stepSim(45)
          clownBackedOff = gapOf() > 5 && window.__aq.teasing() === true

          // 光标挪到别处 → 它照旧凑过来
          aim(30)
          M.cursor.y = 6
          clownFish.x = 30 - 12
          clownFish.y = 6
          clownFish.mode = 'idle'
          clownFish.modeT = 99
          window.__aq.stepSim(75)
          clownCameBack = gapOf() < 6 && window.__aq.teasing() === false
          clownFish.temper = clownTemper
        }

        // ---- 饥饿表现 ----
        M.satiety = 80
        window.__aq.stepSim(1)
        const colorFed = window.__aq.fishColor(0)
        M.satiety = 0
        window.__aq.stepSim(2)
        const colorStarved = window.__aq.fishColor(0)
        const hungryGrey = colorFed !== colorStarved && window.__aq.hungerTier() === 3
        // SAT 3：头顶应该是 !
        M.satiety = 3
        M.fish.forEach((x) => { x.emoteT = 0.01 })
        window.__aq.stepSim(2)
        const starveBang = M.fish.some((x) => x.emote === '!')

        // ---- 换水 / 换草都会：全叫醒 + 洗牌 ----
        M.fish[0].mode = 'sleep'
        M.fish[0].sleepY = M.fish[0].y
        M.crab.mode = 'sleep'
        const crabX0 = M.crab.x
        M.fish[1].mode = 'sleep'
        window.__aq.runAction('clear')
        const clearAwake = M.fish.every((x) => x.mode !== 'sleep') && M.crab.mode !== 'sleep'
        window.__aq.runAction('scape')
        const scapeStill = M.plants.every((pl) => !(pl.waveLife > 0)) // 换草不再抖
        const allAwake = M.fish.every((x) => x.mode !== 'sleep')
        const excited = M.fish.every((x) => x.exciteT > 0) && M.freshT > 0
        const crabMoved = M.crab.mode !== 'sleep' && Math.abs(M.crab.x - crabX0) > 0.5
        const fishExcite = M.fish.every((x) => x.exciteT > 0 && x.exciteMax >= 4)
        const crabExcite = M.crab.mode === 'wander' && M.crab.modeT > 0 && M.crab.exciteT <= 0
        // ---- 换水 / 换一缸水草 ----
        M.pellets.length = 0
        M.bubbles.length = 0
        for (let i = 0; i < 5; i++) window.__aq.model.pellets.push({ x: 10 + i, y: 8, vy: 0, age: 0, settled: true })
        for (let i = 0; i < 8; i++) M.bubbles.push({ x: 12 + i, y: 10, v: 1.5, ph: 0 })
        window.__aq.runAction('clear')
        // 洗牌时每条鱼会吐一个气泡，所以只要求气泡数不超过鱼数
        const clearWater = M.pellets.length === 0 && M.bubbles.length <= M.fish.length && M.surfaceKick > 0 && M.freshT > 0
        window.__aq.runAction('scape')
        const pearlsQueued = M.pearlT > 0 && M.pellets.length === 0
        M.bubbles.length = 0
        window.__aq.stepSim(30) // 2 秒，应该已经冒了珍珠泡
        const pearlsVisible = M.bubbles.length > 0
        // ---- 食欲：饱着不吃、饿着全来 ----
        M.satiety = 100
        const fullIgnores = M.fish.every((x) => !window.__aq.willEat(x, 99991))
        M.satiety = 5
        const ravenousAll = M.fish.every((x) => window.__aq.willEat(x, 99992))
        M.satiety = 3
        // 饿着也吃得到，吃完颜色回来
        const chef = M.fish[0]
        isolateEater(chef)
        chef.x = 20
        chef.y = 10
        chef.scare = 0
        chef.mode = 'cruise'
        chef.modeT = 30
        M.pellets.push({ x: 22.5, y: 10, vy: 0, age: 0, settled: true })
        window.__aq.stepSim(30)
        const ateWhenStarved = M.pellets.length === 0 && M.satiety > 0
        const digestRest = (chef.fullT || 0) > 0
        // 一颗食物只能把 0 抬到 2.5，还在"很饿"档：颜色应该从灰青好转一档（不是立刻恢复本色）
        const revivedColor = window.__aq.fishColor(0) !== colorStarved

        // ---- 抚摸出爱心 ----
        M.satiety = 80
        M.hearts.length = 0
        const pets0 = M.stats.pets
        const pf = M.fish[1] || M.fish[0]
        // 复位：别的鱼赶走、换水状态清掉，免得干扰"停住就摸到"
        M.freshT = 0
        M.pearlT = 0
        M.pet.fish = null
        M.pet.time = 0
        M.fish.forEach((x, i) => {
          x.bumpT = 0
          x.bumpCool = 0
          if (x === pf) return
          x.x = 3 + i * 4
          x.y = 3
          x.mode = 'cruise'
          x.modeT = 30
          x.scare = 0
        })
        pf.x = 30
        pf.y = 9
        pf.mode = 'cruise'
        pf.modeT = 30
        pf.scare = 0
        pf.petCool = 0
        pf.petHeart = 0
        pf.petT = 0
        M.cursor.x = Math.round(pf.x + pf.body.length / 2)
        M.cursor.y = Math.round(pf.y)
        M.cursor.inside = true
        M.cursor.stamp = M.t - 3
        window.__aq.stepSim(20)
        // 只看"有没有冒过爱心"：爱心寿命 1.15s，20 帧是 1.33s，
        // 随机间隔可能刚好落在两次爱心之间，不能拿 hearts.length 当断言
        const petHearts = M.stats.pets > pets0

        // 饿到 15 以下：摸不出爱心
        M.satiety = 5
        M.hearts.length = 0
        const pets1 = M.stats.pets
        pf.x = 30
        pf.y = 9
        pf.petCool = 0
        pf.modeT = 30
        M.cursor.x = Math.round(pf.x + pf.body.length / 2)
        M.cursor.y = Math.round(pf.y)
        M.cursor.stamp = M.t - 3
        window.__aq.stepSim(20)
        const noHeartsStarving = M.hearts.length === 0 && M.stats.pets === pets1

        // ---- 睡着时摸不出爱心，点一下才醒 ----
        M.satiety = 80
        M.hearts.length = 0
        const pets2 = M.stats.pets
        const sf = M.fish[2] || M.fish[0]
        // 把别的鱼赶走，免得"撞一下"把这条睡着的鱼顶偏、点不中
        M.fish.forEach((x, i) => {
          if (x === sf) return
          x.x = 3 + i * 4
          x.y = 3
          x.mode = 'cruise'
          x.modeT = 30
          x.scare = 0
          x.bumpT = 0
          x.bumpCool = 0
        })
        sf.x = 26
        sf.y = 9
        sf.bumpT = 0
        sf.bumpCool = 0
        sf.mode = 'sleep'
        sf.modeT = 30
        sf.rest = true
        sf.sleepY = sf.y
        sf.scare = 0
        sf.petCool = 0
        M.cursor.x = Math.round(sf.x + sf.body.length / 2)
        M.cursor.y = Math.round(sf.y)
        M.cursor.inside = true
        M.cursor.stamp = M.t - 3
        window.__aq.stepSim(25)
        const noHeartsSleeping = M.hearts.length === 0 && M.stats.pets === pets2 && sf.mode === 'sleep'
        // 点它 → 惊醒（scare 覆盖睡觉）
        const px2 = window.__aq.layout()
        window.__aq.clickAt(px2.pad + (Math.round(sf.x) + 1 + 0.5) * px2.cellW, px2.pad + (Math.round(sf.y) + 0.5) * px2.cellH)
        const clickWakesSleeping = sf.scare > 0 && sf.mode === 'cruise'
        M.satiety = 80

        // 兴奋前/后的平均游速（格/秒），不是断言，是给人看的数据
        // 量"路径长度"而不是净位移：鱼来回游净位移会互相抵消
        const measureSpeed = (sec) => {
          let sum = 0
          const frames = Math.round(sec * 15)
          for (let n = 0; n < frames; n++) {
            const s0 = M.fish.map((f) => ({ x: f.x, y: f.y }))
            window.__aq.stepSim(1)
            M.fish.forEach((f, i) => { sum += Math.hypot(f.x - s0[i].x, f.y - s0[i].y) })
          }
          return +(sum / M.fish.length / sec).toFixed(2)
        }
        M.fish.forEach((x) => { x.exciteT = 0 })
        M.freshT = 0
        const speedNormal = measureSpeed(2)
        window.__aq.runAction('scape')
        const speedExcited = measureSpeed(2)
        return JSON.stringify({ speedNormal, speedExcited, afterClick, feeds: M.stats.feeds, dragStarts, dragEnds: M.stats.dragEnds, menuAfterRightClick, menuItems, menuAfterSecondRightClick, hasClown, clownKept, shyFled, shyWallExit, stillApproached, stillDbg: { d0: +d0.toFixed(2), d1: +d1.toFixed(2) }, calmFollowed, mouthOk, ateSettled, themeOk, scares, scared, fedOnFish, crabPinched, crabIgnoredFood, crabStillOnSand, crabChased, crabFled, clownBackedOff, clownCameBack, crabSleptCrouched, crabSleptNoFeet, crabSleptClaws, crabYielded, hungryGrey, clearAwake, scapeStill, allAwake, excited, crabMoved, fishExcite, crabExcite, clearWater, pearlsQueued, pearlsVisible, starveBang, fullIgnores, ravenousAll, ateWhenStarved, digestRest, revivedColor, petHearts, noHeartsStarving, noHeartsSleeping, clickWakesSleeping, fish: M.fish.length })
      } catch (e) { return JSON.stringify({ selftestError: String(e && (e.stack || e.message)) }) } })()`)
      console.log('selftest ' + res)
    }
    if (process.argv.includes('--dark')) {
      // 走真实入口，而不是直接改 model（那样不会切 body 的 dark 类）
      await win.webContents.executeJavaScript(
        "window.__aq.model.theme === 'dark' ? true : window.__aq.runAction('theme')",
      )
      await wait(400)
    }
    if (process.argv.includes('--sleep')) {
      await win.webContents.executeJavaScript(`(() => {
        const m = window.__aq.model
        m.fish.forEach((f, i) => {
          f.mode = 'sleep'
          f.modeT = 30
          f.rest = i % 2 === 1
          f.sleepY = f.rest ? 18.8 : f.y
        })
        return true
      })()`)
      await wait(1400)
    }
    const fishArg = process.argv.find((a) => a.startsWith('--fish='))
    if (fishArg) {
      const n = Number(fishArg.slice('--fish='.length)) || 0
      await win.webContents.executeJavaScript(`(() => {
        const a = window.__aq
        while (a.model.fish.length < ${n}) a.addFish()
        a.model.fish.forEach((f, i) => { f.y = 8 + (i % 5); f.x = 5 + i * 6; f.mode = 'cruise'; f.modeT = 20 })
        // 第一条是小丑鱼，不要覆盖它的配色
        if (a.model.fish[1]) a.model.fish[1].paint = 'rainbow'
        if (a.model.fish[2]) { a.model.fish[2].paint = 'duo'; a.model.fish[2].accent = '#ffe28a' }
        if (a.model.fish[3]) a.model.fish[3].paint = 'mono'
        return a.model.fish.length
      })()`)
      await wait(900)
    }
    if (process.argv.includes('--top')) {
      await win.webContents.executeJavaScript(`(() => {
        window.__aq.model.fish.forEach((f) => { f.y = 2.2; f.mode = 'idle'; f.modeT = 30 })
        return true
      })()`)
      await wait(500)
    }
    if (process.argv.includes('--rescape')) {
      // 截图用：触发「换一缸水草」，等珍珠泡冒出来
      await win.webContents.executeJavaScript(`window.__aq.runAction('scape') || true`)
      await wait(2400)
    }
    if (process.argv.includes('--water')) {
      // 截图用：触发「换一缸清水」，看水面被搅动
      await win.webContents.executeJavaScript(`window.__aq.runAction('clear') || true`)
      await wait(260)
    }
    if (process.argv.includes('--crabclear')) {
      // 截图用：鱼全赶走、螃蟹摆到中间站好
      await win.webContents.executeJavaScript(`(() => {
        const M = window.__aq.model
        M.satiety = 85
        M.crab.x = 26
        M.crab.mode = 'wander'
        M.crab.modeT = 999
        M.crab.pinch = 0
        M.fish.forEach((f, i) => {
          f.x = 44 + (i % 3) * 3
          f.y = 4 + i * 1.2
          f.mode = 'cruise'
          f.modeT = 999
          f.scare = 0
        })
        M.pellets.length = 0
        return true
      })()`)
      await wait(700)
    }    if (process.argv.includes('--crab')) {
      // 点一下螃蟹：走真实的 clickAt 路径，夹人动作当场生效
      await win.webContents.executeJavaScript(`(() => {
        const a = window.__aq
        const c = a.crab()
        const lay = a.layout()
        const cx = Math.round(c.x) + 3
        const cy = Math.round(c.y)
        a.clickAt(lay.pad + (cx + 0.5) * lay.cellW, lay.pad + (cy + 0.5) * lay.cellH)
        return a.model.stats.pinches
      })()`)
      await wait(180)
    }
    const satArg = process.argv.find((a) => a.startsWith('--sat='))
    if (satArg) {
      // 截图用：把饱食度设成指定值，看四档的区分度
      const v = Number(satArg.slice('--sat='.length)) || 0
      await win.webContents.executeJavaScript(`(() => {
        const M = window.__aq.model
        M.satiety = ${v}
        M.fish.forEach((f) => { f.emoteT = 0.05 })
        return true
      })()`)
      await wait(900)
    }    if (process.argv.includes('--clear') || process.argv.includes('--light')) {
      // 截图用：强制透明外壳（不然会跟着存档里的深色模式走）
      await win.webContents.executeJavaScript(`(() => {
        const M = window.__aq.model
        M.theme = 'clear'
        document.body.classList.remove('dark')
        return true
      })()`)
      await wait(350)
    }    if (process.argv.includes('--hungry')) {
      // 截图用：把饱食度清零，看"饿坏"的表现
      await win.webContents.executeJavaScript(`(() => {
        const M = window.__aq.model
        M.satiety = 0
        M.fish.forEach((f) => { f.emoteT = 0.05 })
        return true
      })()`)
      await wait(700)
    }
    if (process.argv.includes('--pet')) {
      // 截图用：把光标停在一条鱼身上，看小爱心
      await win.webContents.executeJavaScript(`(() => {
        const a = window.__aq
        const M = a.model
        const f = M.fish[0]
        f.x = 24
        f.y = 8
        f.mode = 'cruise'
        f.modeT = 30
        f.scare = 0
        M.satiety = 80
        M.cursor.x = Math.round(f.x + f.body.length / 2)
        M.cursor.y = Math.round(f.y)
        M.cursor.inside = true
        M.cursor.stamp = M.t - 2
        return true
      })()`)
      await wait(1200)
      const dbg = await win.webContents.executeJavaScript(`JSON.stringify({
        hearts: window.__aq.model.hearts.length,
        petTime: +window.__aq.model.pet.time.toFixed(2),
        petFish: !!window.__aq.model.pet.fish,
        cursor: window.__aq.model.cursor,
        f0: { x: +window.__aq.model.fish[0].x.toFixed(1), y: +window.__aq.model.fish[0].y.toFixed(1), petT: +(window.__aq.model.fish[0].petT||0).toFixed(2), petCool: +(window.__aq.model.fish[0].petCool||0).toFixed(2) }
      })`)
      console.log('petdbg ' + dbg)
    }    if (process.argv.includes('--crabsleep')) {
      // 截图用：把螃蟹按进睡姿（蹲下、收脚、合钳）
      await win.webContents.executeJavaScript(`(() => {
        const a = window.__aq
        a.crab().mode = 'sleep'
        a.crab().modeT = 30
        a.crab().pinch = 0
        a.repaint()
        return true
      })()`)
      await wait(220)
    }
    if (wantFeed) {
      await win.webContents.executeJavaScript(
        'window.__aq && window.__aq.feedAt(150, 130); window.__aq && window.__aq.feedAt(232, 96); true',
      )
      await wait(650)
    }
    if (wantMenu) {
      await win.webContents.executeJavaScript('window.__aq && window.__aq.openMenuAt(180, 120); true')
      await wait(260)
    }
    const image = await win.webContents.capturePage()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, image.toPNG())
    console.log('captured ' + target)
  } catch (err) {
    console.error('capture failed: ' + (err && err.message))
  } finally {
    app.quit()
  }
}

// ---------------------------------------------------------------- IPC

/**
 * 改窗口尺寸。
 * 注意：resizable:false 时 Windows 上 setSize/setBounds 会被**直接忽略**，
 * 所以必须先临时允许缩放，改完再关回去（不然窗口还是旧大小，鱼缸在旧窗口左上角重绘，
 * 看不见的那块透明区照样能拖动 —— 就是这个 bug）。
 */
function applyWindowSize(name) {
  const layout = layoutFor(name)
  state.size = name
  if (win && !win.isDestroyed()) {
    const b = win.getBounds()
    const wa = workAreaFor(b.x, b.y, b.width, b.height)
    // 贴着边的话，改完尺寸仍旧贴着那条边（否则缩小后会掉离屏幕角落
    const keepRight = wa.x + wa.width - (b.x + b.width) <= 24
    const keepBottom = wa.y + wa.height - (b.y + b.height) <= 24
    const x = keepRight ? wa.x + wa.width - layout.width : b.x
    const y = keepBottom ? wa.y + wa.height - layout.height : b.y
    const next = keepOnScreen(x, y, layout.width, layout.height)
    win.setResizable(true)
    win.setBounds({ x: next.x, y: next.y, width: layout.width, height: layout.height })
    win.setResizable(false)
    state.x = next.x
    state.y = next.y
  }
  saveState()
  return layout
}

function registerIpc() {
  ipcMain.handle('aq:load', () => ({
    state: { ...state },
    layout: layoutFor(state.size),
  }))

  ipcMain.handle('aq:save', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      if (Number.isFinite(patch.satiety)) state.satiety = patch.satiety
      if (Number.isFinite(patch.fishCount)) state.fishCount = patch.fishCount
      if (Array.isArray(patch.fish)) {
        state.fish = patch.fish
          .filter((p) => p && typeof p === 'object')
          .slice(0, 8)
          .map((p) => ({
            temper: typeof p.temper === 'string' ? p.temper : '',
            paint: typeof p.paint === 'string' ? p.paint : '',
            accent: typeof p.accent === 'string' ? p.accent : '',
            hue: Number.isFinite(p.hue) ? p.hue : 0,
            greed: Number.isFinite(p.greed) ? p.greed : 1,
            rest: p.rest === true,
          }))
      }
    }
    saveState()
    return true
  })

  ipcMain.handle('aq:drag-start', () => {
    startDrag()
    return true
  })

  ipcMain.handle('aq:drag-end', () => finishDrag())

  ipcMain.handle('aq:set-size', (_e, name) => applyWindowSize(name))

  ipcMain.handle('aq:theme', (_e, value) => {
    state.theme = value === 'dark' ? 'dark' : 'clear'
    saveState()
    return state.theme
  })

  ipcMain.handle('aq:top', (_e, value) => {
    const on = !!value
    state.alwaysOnTop = on
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(on, 'floating')
    saveState()
    return on
  })

  ipcMain.handle('aq:manual', async () => {
  // 说明书放在程序目录的上一级：开发布局在项目根，发布包里在 exe 旁边
  const file = path.join(__dirname, '..', '说明书.html')
  if (!fs.existsSync(file)) return { ok: false, file }
  const err = await shell.openPath(file)
  return { ok: !err, file, err }
})
ipcMain.handle('aq:quit', () => {
    saveState()
    app.quit()
    return true
  })
}

// ---------------------------------------------------------------- 生命周期

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    loadState()
    registerIpc()
    createWindow()
  })

  app.on('window-all-closed', () => {
    saveState()
    app.quit()
  })

  app.on('before-quit', () => {
    stopDrag()
    saveState()
  })
}
