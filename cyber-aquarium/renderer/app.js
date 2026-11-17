'use strict'

/**
 * ASCII 赛博鱼缸 —— 渲染 + 交互
 *
 * 交互约定（跟 dsh-whale-widget 同一套手感）：
 *   按下不动就松手  → 撒鱼食；正好点在鱼身上 → 把鱼惊走（不再投食）
 *   按下移动 > 4px  → 整个鱼缸跟着走（窗口由主进程按光标重定位）
 *   右键            → 菜单；点外面收起；Esc 也收
 * 整个窗口背景透明，只有字符本身是"实体"。
 */

// ---------------------------------------------------------------- 常量

const COLS = 55
const ROWS = 22
const WATER_TOP = 2
const SURFACE_ROW = WATER_TOP // 水波落在水的第一行，之上才是空气
const WATER_BOTTOM = 19
const SEABED_ROW = 20
const HUD_ROW = 21

const DRAG_SQ = 16 // 4px²：小于这个位移算点击

const P = {
  frame: '#1f8f8a',
  frameHi: '#63f7e8',
  fishA: '#6ef9ff',
  fishB: '#ff8ada',
  fishC: '#ffe28a',
  pellet: '#ffb347',
  bubble: '#8fd8ff',
  plant: '#2fbf8f',
  plantDim: '#1c6f5e',
  hud: '#9ffcff',
  hudWarn: '#ffc457',
  hudAlarm: '#ff6b6b',
  seal: '#17484d',
  dust: '#1c6f74',
}

// temper 决定对鼠标的性格：
//   shy   胆小型，一靠近就加速逃开
//   still 好奇型，会绕着你**停住不动**的光标转圈
//   calm  被动型，只对正在移动的光标有反应，慢慢凑过来
const KINDS = [
  { body: '><>', color: P.fishA, base: 2.6, temper: 'shy' },
  { body: '><°>', color: P.fishB, base: 2.2, temper: 'still' },
  { body: '><(((·>', color: P.fishC, base: 1.9, temper: 'calm' },
]

// 保底的小丑鱼：橙白竖条，见谁都凑，互动最强
const CLOWN = {
  body: '><(((·>',
  color: '#ff5a00',
  base: 2.4,
  temper: 'clown',
  paint: 'clown',
}
// 小丑鱼是整个缸里最艳的：高饱和橙红 + 暖黄白条 + 深色眼睛 + 更浓的橙光
// 对应 body 的 7 个字符： > < ( ( ( · >
const CLOWN_BANDS = ['#ff2d00', '#ffe9a8', '#ff5a00', '#ff7a00', '#ffe9a8', '#240800', '#ff8a1f']

// 上色方式：六成是彩色（双色头尾 / 彩虹段），四成保持单色
const FISH_COLOR_STYLES = ['duo', 'duo', 'rainbow', 'mono', 'mono']
const FISH_ACCENTS = ['#ff8ada', '#ffe28a', '#8affd0', '#b7a4ff', '#ff9f6e']
const RAINBOW = ['#6ef9ff', '#8affd0', '#ffe28a', '#ff8ada', '#b7a4ff']

// 鱼的四种状态：闲游 / 停住发呆 / 突然加速 / 睡觉
const FISH_MODES = [
  { mode: 'cruise', weight: 5, min: 4, max: 10 },
  { mode: 'idle', weight: 3, min: 1.6, max: 4.2 },
  { mode: 'burst', weight: 2, min: 0.9, max: 2.2 },
  { mode: 'sleep', weight: 2, min: 7, max: 16 },
]

// 水草的色调（形状/摆幅每株单独随机，靠形态做变化比换字符靠谱：
// `/ \ ~` 这类斜向字符在一行一格的茎上会排成"电线杆"）
const PLANT_TONES = [
  { color: '#2fbf8f', dim: '#1c6f5e' },
  { color: '#3fae7c', dim: '#1f6a55' },
  { color: '#4fbf95', dim: '#276e56' },
  { color: '#2fa9a0', dim: '#1b5f5c' },
]

// 沙面上的小螃蟹：横着走，不长个儿，只在沙堆那一行活动。
// 心情随机切换：跟着光标跑 / 被吓着躲开 / 自己左晃右晃；点它会夹你一下，鱼食一口不动。
const CRAB = {
  y: SEABED_ROW - 2, // 18：身子在这儿，下面两条脚 v 落在第 19 行的沙线上，钳子抬在第 17 行
  w: 9, // 一共 9 格：_/(o,o)\_ ，外面那两条是折角腿
  minX: 1.5,
  maxX: COLS - 2.5 - 9,
  claw: '#ffb36b',
  body: '#ff7a45',
  leg: '#c2643c',
  eye: '#ffe9a8',
  eyeDim: '#c9a06a', // 睡觉时闭着的眼睛
  flash: '#ffd166',
  sand: '#a2705a', // 走动时踢起来的沙粒
}

// ---------------------------------------------------------------- 画布

const canvas = document.getElementById('tank')
const ctx = canvas.getContext('2d', { alpha: true })
const menuEl = document.getElementById('menu')

let layout = { cols: COLS, rows: ROWS, cellW: 7, cellH: 13, pad: 12, width: 409, height: 310 }
const view = { w: 409, h: 310 }

const CELLS = COLS * ROWS
const bufCh = new Array(CELLS).fill(' ')
const bufCo = new Array(CELLS).fill('#ffffff')

// ---------------------------------------------------------------- 模型

const model = {
  satiety: 72,
  sizeName: 'medium',
  theme: 'clear',
  alwaysOnTop: true,
  fish: [],
  pellets: [],
  bubbles: [],
  dust: [],
  plants: [],
  sandPuffs: [],
  cursor: { x: -1, y: -1, inside: false, stamp: 0 },
  t: 0,
  menuOpen: false,
  crab: { x: 24, y: CRAB.y, dir: 1, mode: 'wander', modeT: 2.5, pinch: 0, pinchFrom: 0, walk: 0, speed: 0, stride: 0, puffs: 1, dodgeDir: 0 },
  stats: { dragStarts: 0, dragEnds: 0, feeds: 0, scares: 0, paints: 0, pinches: 0, yields: 0 },
}

let down = null
let suppressPointer = false

// ---------------------------------------------------------------- 小工具

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const rand = (lo, hi) => lo + Math.random() * (hi - lo)
const pick = (arr) => arr[(Math.random() * arr.length) | 0]

function mirror(text) {
  let out = ''
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    out += ch === '<' ? '>' : ch === '>' ? '<' : ch === '(' ? ')' : ch === ')' ? '(' : ch
  }
  return out
}

function put(c, r, ch, color) {
  c = Math.round(c)
  r = Math.round(r)
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return
  const i = r * COLS + c
  bufCh[i] = ch
  bufCo[i] = color
}

function putText(c, r, text, color) {
  for (let i = 0; i < text.length; i++) put(c + i, r, text[i], color)
}

// ---------------------------------------------------------------- 尺寸

function fitCanvas() {
  const w = Math.max(1, Math.round(document.documentElement.clientWidth))
  const h = Math.max(1, Math.round(document.documentElement.clientHeight))
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  view.w = w
  view.h = h
  // 量字体的实际字宽占比，反推字号，让一个字符正好占满一格
  ctx.font = '100px Consolas, "Cascadia Mono", "Courier New", monospace'
  const advance = Math.max(0.4, ctx.measureText('M').width / 100)
  const fs = Math.min(layout.cellW / advance, layout.cellH * 1.12)
  ctx.font = `${fs.toFixed(2)}px Consolas, "Cascadia Mono", "Courier New", monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
}

// ---------------------------------------------------------------- 世界

function makeFish(spec) {
  const kind = spec || pick(KINDS)
  return {
    body: kind.body,
    color: kind.color,
    base: kind.base,
    temper: kind.temper,
    orbit: 0,
    x: rand(3, COLS - 4 - kind.body.length),
    y: rand(WATER_TOP + 2, WATER_BOTTOM - 0.4),
    dir: Math.random() < 0.5 ? -1 : 1,
    targetY: null,
    think: rand(0.3, 2.2),
    seed: rand(0, 6.28),
    scare: 0,
    fleeX: 0,
    trail: 0,
    mode: 'cruise',
    modeT: rand(2, 6),
    sleepY: 0,
    // 有些鱼贴着沙面睡，有些就悬在水层里 —— 真实鱼两种都有，但都不"掉下去"
    rest: Math.random() < 0.35,
    paint: kind.paint || pick(FISH_COLOR_STYLES),
    accent: pick(FISH_ACCENTS),
    hue: (Math.random() * RAINBOW.length) | 0,
  }
}

function addFish(clown) {
  if (model.fish.length >= 8) return false
  model.fish.push(makeFish(clown ? CLOWN : null))
  return true
}

function spawnPellet(x, y) {
  model.pellets.push({
    x: clamp(x, 1.4, COLS - 2.6),
    y: clamp(y, WATER_TOP + 0.2, WATER_BOTTOM),
    vy: 1.6,
    sway: rand(0, 6.28),
    age: 0,
    settled: false,
  })
  if (model.pellets.length > 24) model.pellets.shift()
}

/** 鱼嘴在行进方向的最前面那个字符（气泡得从这儿出来） */
function fishMouth(f) {
  return f.dir > 0 ? f.x + f.body.length - 1 : f.x
}

function spawnBubble(x, y, up = 1) {
  model.bubbles.push({ x, y, v: rand(1.2, 2.4) * up, ph: rand(0, 6.28) })
  if (model.bubbles.length > 44) model.bubbles.shift()
}

function seedDust() {
  model.dust.length = 0
  for (let i = 0; i < 16; i++) {
    model.dust.push({
      x: rand(1.2, COLS - 2),
      y: rand(WATER_TOP + 0.4, WATER_BOTTOM - 0.2),
      drift: rand(-0.16, 0.16),
      bob: rand(0, 6.28),
      speed: rand(0.3, 1),
    })
  }
}

function seedPlants() {
  model.plants.length = 0
  const want = 9
  let guard = 0
  while (model.plants.length < want && guard++ < 400) {
    // 位置随机，只要求别挤在一起 —— 不做等距排布
    const x = rand(4, COLS - 5)
    if (model.plants.some((p) => Math.abs(p.x - x) < 2.2)) continue
    model.plants.push({
      x,
      h: 3 + Math.round(rand(0, 5)),
      phase: rand(0, 6.28),
      push: 0,
      tone: (Math.random() * PLANT_TONES.length) | 0,
      amp: rand(1.7, 3.3),
      rate: rand(0.34, 0.6),
      bud: Math.random() < 0.45,
    })
  }
}

// ---------------------------------------------------------------- 模拟

function step(dt) {
  model.t += dt
  // 饱食度衰减：满 100 点大约撑 5 小时
  model.satiety = clamp(model.satiety - dt * (100 / (5 * 3600)), 0, 100)

  stepPellets(dt)
  for (const f of model.fish) stepFish(f, dt)
  stepCrab(dt)
  stepSandPuffs(dt)
  stepBubbles(dt)
  stepDust(dt)
  stepPlants(dt)
}

function stepPellets(dt) {
  for (let i = model.pellets.length - 1; i >= 0; i--) {
    const p = model.pellets[i]
    p.age += dt
    if (!p.settled) {
      p.y += p.vy * dt
      // 沉得慢一点，并且带一点点横向漂
      p.x += Math.sin(model.t * 1.3 + p.sway) * 0.35 * dt
      if (p.y >= SEABED_ROW - 0.35) {
        p.y = SEABED_ROW - 0.35
        p.settled = true
      }
    }
    if (p.age > 24) model.pellets.splice(i, 1)
  }
}

function stepFish(f, dt) {
  f.think -= dt
  f.modeT -= dt
  const cx = f.x + f.body.length / 2

  // 受惊：朝反方向窜一小段
  if (f.scare > 0) {
    f.scare -= dt
    f.dir = f.fleeX >= f.x ? -1 : 1
    f.x += f.dir * f.base * 3.2 * dt
    f.y += Math.sin(model.t * 9 + f.seed) * 1.4 * dt
    f.trail -= dt
    if (f.trail <= 0) {
      f.trail = 0.06
      spawnBubble(fishMouth(f), f.y - 0.2)
    }
    clampFish(f)
    return
  }

  const pellet = nearestPellet(f)
  if (pellet && model.satiety < 99.5) {
    if (f.mode === 'sleep') {
      f.mode = 'cruise'
      f.modeT = rand(3, 6)
    }
    const dx = pellet.x - cx
    const dy = pellet.y - f.y
    if (dx !== 0) f.dir = dx > 0 ? 1 : -1
    const sp = f.base * 1.9
    f.x += Math.sign(dx) * Math.min(Math.abs(dx), sp * dt)
    f.y += Math.sign(dy) * Math.min(Math.abs(dy), sp * 0.85 * dt)
    // 纵向判定要够宽：落在沙面（19.65）的鱼食，鱼最多只到 18.8，差值 0.85
    if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.15) eat(f, pellet)
    clampFish(f)
    return
  }

  // 对鼠标的反应，按各自性格来
  if (stepCursorPull(f, dt)) return

  // 状态切换：闲游 / 发呆 / 加速 / 睡觉
  if (f.modeT <= 0) {
    f.mode = pickMode()
    const def = FISH_MODES.find((m) => m.mode === f.mode)
    f.modeT = rand(def.min, def.max)
    if (f.mode === 'sleep') {
      // 睡在水层里的保持当前深度（靠浮力和鳍稳住），贴底睡法的才往沙面靠
      f.sleepY = f.rest ? SEABED_ROW - 1.2 : clamp(f.y, WATER_TOP + 2, WATER_BOTTOM - 0.6)
    }
    if (f.mode === 'cruise' || f.mode === 'burst') {
      f.targetY = rand(WATER_TOP + 2, WATER_BOTTOM - 1.5)
      f.think = rand(1.5, 4)
      if (Math.random() < 0.5) f.dir = Math.random() < 0.5 ? -1 : 1
    }
  }

  // 发呆：原地轻轻浮沉，不前进
  if (f.mode === 'idle') {
    f.y += Math.sin(model.t * 1.7 + f.seed) * 0.3 * dt
    clampFish(f)
    return
  }

  // 睡觉：停在原地不动。悬停型的靠浮力保持深度，只有贴底型才缓慢靠向沙面。
  // （真实鱼睡觉不会自由下沉 —— 那多半是病了）
  if (f.mode === 'sleep') {
    const dy = f.sleepY - f.y
    if (Math.abs(dy) > 0.12) {
      f.y += Math.sign(dy) * Math.min(Math.abs(dy), (f.rest ? 0.42 : 0.2) * dt)
    } else {
      f.y += Math.sin(model.t * 0.7 + f.seed) * 0.1 * dt
    }
    clampFish(f)
    return
  }

  // 闲游 / 加速
  if (f.think <= 0) {
    f.think = rand(2, 5)
    if (Math.random() < 0.4) f.dir *= -1
  }
  const speed = f.mode === 'burst' ? f.base * 2.9 : f.base
  f.x += f.dir * speed * dt
  const minX = 1.25
  const maxX = COLS - 2 - f.body.length
  if (f.x <= minX) {
    f.x = minX
    f.dir = 1
  } else if (f.x >= maxX) {
    f.x = maxX
    f.dir = -1
  }
  if (f.targetY != null) {
    const dy = f.targetY - f.y
    f.y += Math.sign(dy) * Math.min(Math.abs(dy), 0.8 * dt)
  }
  if (Math.random() < dt * (f.mode === 'burst' ? 0.6 : 0.1)) {
    spawnBubble(fishMouth(f), f.y - 0.2)
  }
  clampFish(f)
}

/**
 * 对鼠标的反应，按鱼的性格分三种：
 *   shy   看到你在旁边就加速逃开（胆小的）
 *   still 你不动了它才好奇，会绕着光标转圈
 *   calm  只理"正在动"的光标，慢慢凑过来
 * 返回 true 表示这一帧被鼠标接管了。
 */
function stepCursorPull(f, dt) {
  const cur = model.cursor
  if (!cur.inside) {
    f.orbit = 0
    return false
  }
  const cx = f.x + f.body.length / 2
  const vx = cx - cur.x
  const vy = f.y - cur.y
  const dist = Math.hypot(vx, vy)
  const since = model.t - cur.stamp

  if (f.temper === 'shy') {
    if (dist > 7) {
      f.orbit = 0
      return false
    }
    f.orbit = 0
    // 朝远离光标的方向加速窜
    f.dir = vx > 0 ? 1 : -1
    f.x += f.dir * f.base * 2.5 * dt
    f.y += (vy > 0 ? 1 : -1) * 0.7 * dt
    if (Math.random() < dt * 3) spawnBubble(fishMouth(f), f.y - 0.2)
    f.mode = 'cruise'
    f.modeT = Math.max(f.modeT, 1)
    clampFish(f)
    return true
  }

  if (f.temper === 'still') {
    // 光标停住一小会儿才开始好奇
    if (since < 1.2 || dist > 13) {
      f.orbit = 0
      return false
    }
    if (!f.orbit) f.orbit = Math.random() < 0.5 ? 1 : -1
    const r = Math.max(dist, 0.001)
    const ux = vx / r
    const uy = vy / r
    const tx = -uy * f.orbit
    const ty = ux * f.orbit
    // u 是从光标指向鱼的方向：r 太大要往回收，所以是减
    const err = clamp((r - 3.4) * 0.8, -1.2, 1.2)
    f.x += (tx * f.base * 0.9 - ux * err * 2.2) * dt
    f.y += (ty * f.base * 0.5 - uy * err * 1.6) * dt
    f.dir = tx >= 0 ? 1 : -1
    f.mode = 'cruise'
    f.modeT = Math.max(f.modeT, 1)
    clampFish(f)
    return true
  }

  if (f.temper === 'clown') {
    // 你在逗螃蟹的时候它会懂点事：不去抢戏，离得太近还会自己退开一点
    if (teasingCrab()) {
      f.orbit = 0
      if (dist < 6) {
        f.dir = vx > 0 ? 1 : -1
        f.x += f.dir * f.base * 1.1 * dt
        f.y += (vy > 0 ? 1 : -1) * 0.4 * dt
        f.mode = 'cruise'
        f.modeT = Math.max(f.modeT, 1)
        clampFish(f)
        return true
      }
      return false
    }
    // 互动最强：你动不动它都来，而且贴得更近
    if (dist > 18) {
      f.orbit = 0
      return false
    }
    if (!f.orbit) f.orbit = Math.random() < 0.5 ? 1 : -1
    const r = Math.max(dist, 0.001)
    const ux = vx / r
    const uy = vy / r
    const tx = -uy * f.orbit
    const ty = ux * f.orbit
    const err = clamp((r - 2.2) * 1.0, -1.6, 1.6)
    f.x += (tx * f.base * 1.3 - ux * err * 3.0) * dt
    f.y += (ty * f.base * 0.7 - uy * err * 2.2) * dt
    f.x = clamp(f.x, 1.25, COLS - 2 - f.body.length)
    f.dir = tx >= 0 ? 1 : -1
    f.mode = 'cruise'
    f.modeT = Math.max(f.modeT, 2)
    clampFish(f)
    return true
  }

  // calm：只对正在移动的光标有反应
  f.orbit = 0
  if (since > 0.9 || dist > 8) return false
  f.dir = cur.x > cx ? 1 : -1
  const gap = cur.x - f.body.length / 2 - f.x
  if (Math.abs(gap) > 3) f.x += Math.sign(gap) * f.base * 0.4 * dt
  if (Math.abs(vy) > 1) f.y += (vy > 0 ? -1 : 1) * 0.6 * dt
  f.mode = 'cruise'
  f.modeT = Math.max(f.modeT, 1.5)
  clampFish(f)
  return true
}

function pickMode() {
  let total = 0
  for (const m of FISH_MODES) total += m.weight
  let r = Math.random() * total
  for (const m of FISH_MODES) {
    r -= m.weight
    if (r <= 0) return m.mode
  }
  return 'cruise'
}

function clampFish(f) {
  f.y = clamp(f.y, WATER_TOP + 1.6, WATER_BOTTOM - 0.2)
}

function stepBubbles(dt) {
  for (let i = model.bubbles.length - 1; i >= 0; i--) {
    const b = model.bubbles[i]
    b.y -= b.v * dt
    b.x += Math.sin(model.t * 2.4 + b.ph) * 1.1 * dt
    b.x = clamp(b.x, 1.2, COLS - 2.2)
    if (b.y < SURFACE_ROW + 0.2) model.bubbles.splice(i, 1)
  }
  if (Math.random() < dt * 1.4) spawnBubble(rand(2, COLS - 3), SEABED_ROW - 0.6)
}

function stepDust(dt) {
  for (const d of model.dust) {
    d.x += d.drift * dt
    d.y += Math.sin(model.t * 0.6 + d.bob) * 0.22 * d.speed * dt
    if (d.x < 1.2) d.x = COLS - 2
    if (d.x > COLS - 2) d.x = 1.2
    d.y = clamp(d.y, WATER_TOP + 1.8, WATER_BOTTOM - 0.1)
  }
}

function stepPlants(dt) {
  for (const pl of model.plants) {
    let target = 0
    for (const f of model.fish) {
      if (f.mode === 'sleep' || f.mode === 'idle') continue
      const d = f.x + f.body.length / 2 - pl.x
      if (Math.abs(d) < 5) {
        // 顺着鱼游的方向带走，不是简单地把草推开
        target += f.dir * (1 - Math.abs(d) / 5) * 2.0
      }
    }
    // 比鱼慢一拍收住，才有"被水带了一下又弹回去"的感觉
    pl.push += (target - pl.push) * Math.min(1, dt * 3.5)
  }
}

// ---------------------------------------------------------------- 螃蟹

/**
 * 光标是不是正在逗螃蟹：贴着螃蟹左右那一片，或者刚被夹完的半秒。
 * 小丑鱼靠这个判断"现在不该凑热闹"。
 */
function teasingCrab() {
  const crab = model.crab
  if (crab.pinch > 0) return true
  const cur = model.cursor
  if (!cur.inside) return false
  const cx = crab.x + CRAB.w / 2
  return Math.abs(cur.x - cx) <= 7 && cur.y >= CRAB.y - 3
}

/**
 * 螃蟹只干这几件事，心情到点随机换（大部分时间在发懒）：
 *   sleep  蹲下睡觉：脚收起来、钳子合上
 *   wander 自己左右晃两下，然后站一会儿
 *   chase  跟着光标横着跑（光标凑近了才来劲）
 *   flee   躲光标（被点一下也会切到这个）
 *   dodge  别的鱼贴脸游过来时，看心情让一下
 * 它永远待在沙面上，也不会去吃鱼食。
 */
function pickCrabMode(cx) {
  const near = model.cursor.inside && Math.abs(model.cursor.x - cx) <= 12
  const r = Math.random()
  if (r < 0.32) return { mode: 'sleep', modeT: rand(7, 16) }
  if (r < 0.76) return { mode: 'wander', modeT: rand(5, 11) }
  if (near && r < 0.91) return { mode: 'chase', modeT: rand(1.2, 2.4) }
  if (near) return { mode: 'flee', modeT: rand(0.8, 1.6) }
  return { mode: 'wander', modeT: rand(3, 6) }
}

/** 别的鱼贴着沙面游过来：看心情横向让一下；睡着的时候基本懒得理 */
function yieldToFish(dt, cx) {
  const crab = model.crab
  if (crab.mode === 'dodge' || crab.pinch > 0) return
  for (const f of model.fish) {
    if (f.mode === 'sleep') continue
    if (f.y < CRAB.y - 2.2) continue // 只在意贴着沙面的鱼
    const dx = f.x + f.body.length / 2 - cx
    if (Math.abs(dx) > 5.5) continue
    const p = crab.mode === 'sleep' ? dt * 0.18 : dt * 2.2
    if (Math.random() >= p) continue
    crab.mode = 'dodge'
    crab.modeT = rand(0.6, 1.2)
    crab.dodgeDir = dx > 0 ? -1 : 1
    model.stats.yields++
    return
  }
}

function stepCrab(dt) {
  const crab = model.crab
  const cx = crab.x + CRAB.w / 2
  crab.modeT -= dt
  if (crab.pinch > 0) crab.pinch = Math.max(0, crab.pinch - dt)

  if (crab.modeT <= 0) {
    const next = pickCrabMode(cx)
    crab.mode = next.mode
    crab.modeT = next.modeT
  }

  yieldToFish(dt, cx)

  let vx = 0
  if (crab.mode === 'sleep') {
    vx = 0
  } else if (crab.mode === 'chase' && model.cursor.inside) {
    const d = model.cursor.x - cx
    if (Math.abs(d) > 1.4) vx = Math.sign(d) * 2.0
  } else if (crab.mode === 'flee') {
    // 光标在水里就横向躲开；不在水里就自己找边溜
    const d = model.cursor.inside ? cx - model.cursor.x : Math.cos(model.t * 0.8) * 4
    vx = (d === 0 ? 1 : Math.sign(d)) * 3.4
  } else if (crab.mode === 'dodge') {
    vx = (crab.dodgeDir || 1) * 2.6
  } else {
    // 溜达：晃两下、站一会儿 —— 有明确的"停住"时段，不然原地一直在抖
    const sway = Math.sin(model.t * 0.75 + crab.x * 0.4)
    vx = Math.abs(sway) < 0.6 ? 0 : Math.sign(sway) * 0.75
  }

  if (vx !== 0) {
    crab.dir = vx > 0 ? 1 : -1
    crab.walk += Math.abs(vx) * dt
    // 步伐按"走过的距离"累计：站着不动就不涨，脚也就不会抽
    crab.stride += Math.abs(vx) * dt * 2.4
    crab.puffs -= Math.abs(vx) * dt
    if (crab.puffs <= 0) {
      crab.puffs = rand(0.55, 1.2)
      model.sandPuffs.push({
        x: cx + rand(-2.4, 2.4),
        y: CRAB.y + 1.5,
        vx: rand(-0.7, 0.7),
        age: 0,
      })
      if (model.sandPuffs.length > 18) model.sandPuffs.shift()
    }
  }
  // 画脚用：走路时按这个速度换踏步的节奏
  crab.speed = vx

  const next = crab.x + vx * dt
  if (next < CRAB.minX || next > CRAB.maxX) {
    // 撞到缸壁就掉头，别贴着边缘抽搐
    crab.x = clamp(next, CRAB.minX, CRAB.maxX)
    crab.mode = 'wander'
    crab.modeT = rand(0.8, 1.8)
  } else {
    crab.x = next
  }
}

function stepSandPuffs(dt) {
  for (let i = model.sandPuffs.length - 1; i >= 0; i--) {
    const p = model.sandPuffs[i]
    p.age += dt
    p.y -= dt * 0.3
    p.x += p.vx * dt
    if (p.age > 1.1) model.sandPuffs.splice(i, 1)
  }
}

/** 点在螃蟹身上（身子那行、钳子那行、短腿那行都算） */
function crabAt(c, r) {
  const crab = model.crab
  const y = Math.round(crab.y)
  const rr = Math.round(r)
  if (rr !== y && rr !== y - 1 && rr !== y + 1) return false
  const x0 = Math.round(crab.x)
  return c >= x0 - 0.4 && c <= x0 + CRAB.w - 0.6
}

/** 被点 → 夹一下，然后横着窜开，顺手扬一把沙 */
function pinchCrab(cell) {
  const crab = model.crab
  crab.pinch = 0.75
  crab.pinchFrom = cell.c
  crab.mode = 'flee'
  crab.modeT = rand(1.1, 1.8)
  crab.dir = cell.c < crab.x + CRAB.w / 2 ? 1 : -1
  model.stats.pinches++
  for (let i = 0; i < 4; i++) {
    model.sandPuffs.push({
      x: crab.x + CRAB.w / 2 + rand(-1.6, 1.6),
      y: CRAB.y + 1.5,
      vx: rand(-1.2, 1.2),
      age: 0,
    })
  }
  return true
}

function nearestPellet(f) {
  const cx = f.x + f.body.length / 2
  let best = null
  let bestD = Infinity
  for (const p of model.pellets) {
    const dx = p.x - cx
    const dy = p.y - f.y
    const d = dx * dx + dy * dy * 2.4
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

function eat(f, pellet) {
  const i = model.pellets.indexOf(pellet)
  if (i >= 0) model.pellets.splice(i, 1)
  model.satiety = clamp(model.satiety + 2.5, 0, 100)
  spawnBubble(pellet.x, pellet.y)
  f.think = 0.2
}

/** 点在中鱼身上 → 惊走，不投食 */
function fishAt(c, r) {
  for (const f of model.fish) {
    const c0 = Math.round(f.x)
    if (Math.round(f.y) === r && c >= c0 - 1 && c <= c0 + f.body.length) return f
  }
  return null
}

function scareFish(f, cell) {
  f.scare = 1.1
  f.fleeX = cell.c
  f.think = 0.2
  model.stats.scares++
  for (let i = 0; i < 3; i++) spawnBubble(fishMouth(f) + rand(-0.6, 0.6), f.y - 0.2)
}

// ---------------------------------------------------------------- 绘制

function clearGrid() {
  for (let i = 0; i < CELLS; i++) bufCh[i] = ' '
}

function compose() {
  drawSurface()
  drawDust()

  drawPlants()

  for (const p of model.pellets) {
    const fade = p.age > 20 && Math.floor(model.t * 6) % 2 === 0
    put(p.x, p.y, fade ? '·' : '*', P.pellet)
  }

  for (const b of model.bubbles) {
    const ch = b.y < WATER_TOP + 2 ? 'o' : '°'
    put(b.x, b.y, ch, P.bubble)
  }

  // 鱼（越靠上层越暗，做出纵深）
  for (const f of model.fish) {
    const body = f.dir > 0 ? f.body : mirror(f.body)
    const c0 = Math.round(f.x)
    const r = Math.round(f.y)
    const asleep = f.mode === 'sleep'
    // 颜色出生时定死，游到哪一层、睡不睡都不改（只有被戳那一下闪白）
    for (let i = 0; i < body.length; i++) {
      put(c0 + i, r, body[i], fishCharColor(f, i, body.length))
    }
    if (asleep) {
      // 睡着的鱼头顶飘一个 z，慢慢眨眼
      put(c0 + body.length + 1, r - 1, Math.floor(model.t * 0.8) % 2 === 0 ? 'z' : 'Z', '#2f8e89')
    }
  }

  // 螃蟹走动踢起来的沙
  for (const p of model.sandPuffs) put(p.x, p.y, '·', CRAB.sand)

  // 螃蟹压在沙面上，所以在水草和鱼之后画（挡住草根那一截）
  drawCrab()

  drawHud()
}

const SURF_GLYPHS = ['~', '-', '~', "'", '~', '`']

/** 水面：占两行，第一行密、第二行只留较高的波峰，形成往下淡出的过渡 */
function drawSurface() {
  const s = model.t * 2.1
  for (let c = 2; c < COLS - 2; c++) {
    const p = c - s
    const jitter = Math.sin(c * 12.9898 + 78.233) * 43758.5453
    const j = jitter - Math.floor(jitter)
    const base = Math.sin(p * 0.52) + Math.sin(p * 1.63 + 1.2) * 0.55 + Math.sin(p * 0.27 + 4.1) * 0.85
    const n = base + (j - 0.5) * 0.9

    if (n > 0.6) put(c, SURFACE_ROW, SURF_GLYPHS[c % SURF_GLYPHS.length], '#2a8f8a')
    else if (n > 0.2) put(c, SURFACE_ROW, SURF_GLYPHS[(c * 5 + 1) % SURF_GLYPHS.length], '#1c5f63')

    // 第二行：整组相位挪开，让它的波峰落在第一行的空隙里，看起来才是往下散开
    const q = p + 3.1
    const n2 =
      Math.sin(q * 0.52) + Math.sin(q * 1.63 + 1.2) * 0.55 + Math.sin(q * 0.27 + 4.1) * 0.85 + (j - 0.5) * 0.9
    if (n2 > 0.95) put(c, SURFACE_ROW + 1, SURF_GLYPHS[(c * 3 + 1) % SURF_GLYPHS.length], '#174d52')
  }
}

function drawDust() {
  for (const d of model.dust) put(d.x, d.y, '·', P.dust)
}

/** 水草：摆动集中在梢部，逐行相位差很小，才像被水推着弯，而不是螺丝钉 */
function drawPlants() {
  for (const pl of model.plants) {
    const tone = PLANT_TONES[pl.tone] || PLANT_TONES[0]
    for (let k = 0; k < pl.h; k++) {
      const t = (k + 1) / pl.h
      const wave = Math.sin(model.t * pl.rate + pl.phase - k * 0.3) * pl.amp * t
      const off = Math.round(wave + pl.push * Math.pow(t, 1.5))
      const r = SEABED_ROW - 1 - k
      const idx = off > 0 ? 2 : off < 0 ? 1 : 0
      let ch = k === 0 ? '|' : idx === 0 ? '|' : idx === 2 ? ')' : '('
      if (pl.bud && k === pl.h - 1) ch = '°'
      put(pl.x + off, r, ch, t < 0.45 ? tone.dim : tone.color)
    }
  }
}

let crabGlyphs = []

/**
 * 螃蟹（清醒时三行 / 睡着时两行，9 格宽）：
 *      V  . .  V     ← 抬起来的两只钳子 + 壳上方两个点当眼睛
 *      _/(_^_)\_     ← 拱顶壳 + 侧面两条折角腿（_/ 和 \_）
 *        v   v       ← 两只脚，踩在沙线上（分开站）
 * 睡着的时候：整体往下一格蹲在沙面上，脚收起来，钳子合上不再动，眼睛闭成 -。
 * 心情不同钳子姿态不同：跟着你时指着你、躲的时候乱挥、被夹的时候"啪"地合上。
 * 画进网格的同时把字形记下来，发光层再照着描一遍（跟鱼同一套做法）。
 */
function drawCrab() {
  crabGlyphs = []
  const crab = model.crab
  const x = Math.round(crab.x)
  const y = Math.round(crab.y)
  const asleep = crab.mode === 'sleep' && crab.pinch <= 0
  const by = asleep ? y + 1 : y // 蹲下去：整只降一行，正好坐在沙面上
  const pinching = crab.pinch > 0
  const snap = Math.floor(crab.pinch * 16) % 2 === 1
  const blink = !pinching && Math.floor(model.t * 3.2 + 2) % 9 === 3
  const flail = Math.floor(model.t * 8) % 2 === 0

  let left = 'V'
  let right = 'V'
  if (asleep) {
    // 睡着：钳子合上收着
    left = '>'
    right = '<'
  } else if (pinching) {
    left = snap ? '>' : 'V'
    right = snap ? '<' : 'V'
  } else if (crab.mode === 'chase') {
    const towardLeft = model.cursor.inside && model.cursor.x < x + CRAB.w / 2
    left = towardLeft ? '<' : 'V'
    right = towardLeft ? 'V' : '>'
  } else if (crab.mode === 'flee') {
    left = flail ? '\\' : '/'
    right = flail ? '/' : '\\'
  }

  const clawCo = pinching ? CRAB.flash : CRAB.claw
  const glyph = (gx, gy, ch, color) => {
    put(gx, gy, ch, color)
    crabGlyphs.push({ c: Math.round(gx), r: Math.round(gy), ch, color })
  }

  // 侧面两条折角腿：_ 贴地、/ \ 撑着壳
  glyph(x, by, '_', CRAB.leg)
  glyph(x + 1, by, '/', CRAB.leg)
  glyph(x + 7, by, '\\', CRAB.leg)
  glyph(x + 8, by, '_', CRAB.leg)

  // 壳：拱顶 (_^_)
  glyph(x + 2, by, '(', CRAB.body)
  glyph(x + 3, by, '_', CRAB.body)
  glyph(x + 4, by, '^', CRAB.body)
  glyph(x + 5, by, '_', CRAB.body)
  glyph(x + 6, by, ')', CRAB.body)

  // 钳子：抬在壳上面一行，最左最右各一只
  glyph(x, by - 1, left, clawCo)
  glyph(x + 8, by - 1, right, clawCo)

  // 眼睛：壳正上方两个点；睡着时闭成两条短横，眨眼时整帧不画
  if (asleep) {
    glyph(x + 3, by - 1, '-', CRAB.eyeDim)
    glyph(x + 5, by - 1, '-', CRAB.eyeDim)
  } else if (!blink) {
    glyph(x + 3, by - 1, '.', CRAB.eye)
    glyph(x + 5, by - 1, '.', CRAB.eye)
  }

  // 脚：睡着时收起来，只留蹲在沙面上的壳
  if (!asleep) {
    // 走路时一抬一落（抬起那条画成 ' ，像把脚缩起来），站着两只都落地
    // 节奏跟"走过的距离"走（crab.stride），不是跟时间走：站着不动脚就静止
    const stepping = Math.abs(crab.speed || 0) > 0.15
    const stepPhase = Math.floor(crab.stride || 0) % 2 === 0
    glyph(x + 2, by + 1, stepping && stepPhase ? "'" : 'v', CRAB.leg)
    glyph(x + 6, by + 1, stepping && !stepPhase ? "'" : 'v', CRAB.leg)
  }
}

/** 螃蟹的暖橙色辉光（鱼是各鱼本色，螃蟹统一暖橙） */
function drawCrabGlow() {
  if (!crabGlyphs.length) return
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.globalAlpha = 0.92
  ctx.shadowBlur = Math.max(4, layout.cellW * 1.15)
  for (const g of crabGlyphs) {
    ctx.shadowColor = '#ff8a4a'
    ctx.fillStyle = g.color
    ctx.fillText(g.ch, layout.pad + g.c * layout.cellW + layout.cellW / 2, layout.pad + g.r * layout.cellH + layout.cellH / 2)
  }
  ctx.restore()
}

function drawHud() {
  const pct = Math.round(model.satiety)
  const pctColor = pct < 20 ? P.hudAlarm : pct < 45 ? P.hudWarn : P.hud
  putText(2, HUD_ROW, 'SAT', '#2f8e89')
  putText(6, HUD_ROW, String(pct).padStart(3) + '%', pctColor)
  const tail = 'x' + model.fish.length
  putText(COLS - 2 - tail.length, HUD_ROW, tail, '#2f8e89')
}

function drawGrid() {
  const { cellW, cellH, pad } = layout
  const halfX = cellW / 2
  const halfY = cellH / 2

  // 描边：浅色壁纸下也读得清
  ctx.fillStyle = 'rgba(2, 8, 11, 0.62)'
  for (let r = 0; r < ROWS; r++) {
    const y = pad + r * cellH + halfY + 1
    for (let c = 0; c < COLS; c++) {
      const ch = bufCh[r * COLS + c]
      if (ch === ' ') continue
      ctx.fillText(ch, pad + c * cellW + halfX, y)
    }
  }

  for (let r = 0; r < ROWS; r++) {
    const y = pad + r * cellH + halfY
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c
      const ch = bufCh[i]
      if (ch === ' ') continue
      ctx.fillStyle = bufCo[i]
      ctx.fillText(ch, pad + c * cellW + halfX, y)
    }
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/**
 * 边框用几何线条画，不用 ╔═╗ 字符：
 * 等宽字体的框线字形墨迹不满格，逐格拼会露出缝（Consolas / Cascadia 都一样）。
 */
function drawFrame() {
  const x = layout.pad - 6 + 0.5
  const y = layout.pad - 6 + 0.5
  const w = COLS * layout.cellW + 11
  const h = ROWS * layout.cellH + 11

  ctx.save()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(45, 190, 186, 0.95)'
  roundRect(x, y, w, h, 9)
  ctx.stroke()

  ctx.strokeStyle = 'rgba(120, 255, 244, 0.16)'
  roundRect(x + 3, y + 3, w - 6, h - 6, 6)
  ctx.stroke()

  ctx.strokeStyle = 'rgba(150, 255, 248, 0.8)'
  ctx.lineWidth = 1.6
  const L = 10
  const corners = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ]
  for (const [cx, cy, sx, sy] of corners) {
    ctx.beginPath()
    ctx.moveTo(cx + sx * L, cy)
    ctx.lineTo(cx, cy)
    ctx.lineTo(cx, cy + sy * L)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * 沙床：几何填充 + 一条起伏的沙面高光。
 * 之前用 `. , ` 这些标点撒，一屏幕标点在 7px 的格子里看着脏。
 */
function drawSand() {
  const x0 = layout.pad + 1
  const x1 = layout.pad + (COLS - 1) * layout.cellW
  const baseY = layout.pad + 19 * layout.cellH
  const bottom = layout.pad + HUD_ROW * layout.cellH

  const pts = []
  for (let x = x0; x <= x1; x += 2) {
    const t = (x - x0) / (x1 - x0)
    const y = baseY + Math.sin(t * 11 + 1.3) * layout.cellH * 0.22 + Math.sin(t * 27) * layout.cellH * 0.1
    pts.push([x, y])
  }

  ctx.save()
  const grad = ctx.createLinearGradient(0, baseY - layout.cellH, 0, bottom)
  grad.addColorStop(0, 'rgba(58, 196, 176, 0.30)')
  grad.addColorStop(0.55, 'rgba(34, 130, 122, 0.22)')
  grad.addColorStop(1, 'rgba(10, 60, 60, 0.06)')

  ctx.beginPath()
  ctx.moveTo(x0, bottom)
  for (const [x, y] of pts) ctx.lineTo(x, y)
  ctx.lineTo(x1, bottom)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()

  // 沙里嵌的几颗石子
  const pebbles = [
    [0.18, 0.62],
    [0.33, 0.82],
    [0.52, 0.55],
    [0.71, 0.78],
    [0.86, 0.5],
  ]
  ctx.fillStyle = 'rgba(16, 78, 74, 0.32)'
  for (const [tx, ty] of pebbles) {
    ctx.beginPath()
    ctx.ellipse(x0 + (x1 - x0) * tx, baseY + (bottom - baseY) * ty, 2.6, 1.3, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
  ctx.strokeStyle = 'rgba(130, 250, 220, 0.38)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()
}

/** 一条鱼第 i 个字符用哪个颜色（compose 和发光层共用） */
function fishCharColor(f, i, len) {
  if (f.scare > 0) return '#ffffff'
  if (f.paint === 'clown') return CLOWN_BANDS[i] || f.color
  if (f.paint === 'duo') return i === 0 || i === len - 1 ? f.accent : f.color
  if (f.paint === 'rainbow') return RAINBOW[(f.hue + i) % RAINBOW.length]
  return f.color
}

/**
 * 只让鱼的字形发光：把鱼的字符再画一遍，带同色 shadowBlur。
 * 随后正常字符层会盖上去，所以字本身还是脆的，只是周围多一圈光。
 */
function drawFishGlow() {
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.globalAlpha = 0.9
  for (const f of model.fish) {
    const body = f.dir > 0 ? f.body : mirror(f.body)
    const c0 = Math.round(f.x)
    const y = layout.pad + Math.round(f.y) * layout.cellH + layout.cellH / 2
    ctx.shadowBlur = Math.max(4, layout.cellW * 1.1)
    for (let i = 0; i < body.length; i++) {
      const color = fishCharColor(f, i, body.length)
      ctx.shadowColor = color
      ctx.fillStyle = color
      ctx.fillText(body[i], layout.pad + (c0 + i) * layout.cellW + layout.cellW / 2, y)
    }
  }
  ctx.restore()
}

/**
 * 缸内的淡淡底色：只铺在**水面以下**，水波上方是空气，保持纯透明。
 * 上边是平的水面线，下边跟随玻璃圆角。
 */
function drawTankBackdrop() {
  const inset = 4
  const x = layout.pad - inset
  const right = layout.pad + COLS * layout.cellW + inset
  const waterTop = layout.pad + SURFACE_ROW * layout.cellH
  const bottom = layout.pad + ROWS * layout.cellH + inset
  const r = 7

  ctx.beginPath()
  ctx.moveTo(x, waterTop)
  ctx.lineTo(right, waterTop)
  ctx.lineTo(right, bottom - r)
  ctx.quadraticCurveTo(right, bottom, right - r, bottom)
  ctx.lineTo(x + r, bottom)
  ctx.quadraticCurveTo(x, bottom, x, bottom - r)
  ctx.closePath()

  const grad = ctx.createLinearGradient(0, waterTop, 0, bottom)
  grad.addColorStop(0, 'rgba(10, 44, 50, 0.015)')
  grad.addColorStop(0.25, 'rgba(10, 44, 50, 0.045)')
  grad.addColorStop(0.6, 'rgba(10, 44, 50, 0.09)')
  grad.addColorStop(1, 'rgba(8, 38, 46, 0.14)')
  ctx.fillStyle = grad
  ctx.fill()

  // 水面：一条极淡的高光，跟上面的 ~ 波纹一起读作"水线"
  ctx.beginPath()
  ctx.moveTo(x, waterTop + 0.5)
  ctx.lineTo(right, waterTop + 0.5)
  ctx.strokeStyle = 'rgba(120, 255, 244, 0.08)'
  ctx.lineWidth = 1
  ctx.stroke()
}

/**
 * 深色外壳：**不画在画布上**——画布保持透明，辉光才透得出气。
 * 底色交给 CSS 的 body.dark（见 style.css），
 * 效果就等于把这个透明鱼缸拖到一张深色页面上。
 */
function applyTheme() {
  document.body.classList.toggle('dark', model.theme === 'dark')
}

function paint() {
  const t0 = performance.now()
  model.stats.paints++
  ctx.clearRect(0, 0, view.w, view.h)
  clearGrid()
  drawTankBackdrop()
  compose()
  drawFrame()
  drawSand()
  drawFishGlow()
  drawCrabGlow()
  drawGrid()
  const ms = performance.now() - t0
  model.stats.paintMs = model.stats.paintMs ? model.stats.paintMs * 0.9 + ms * 0.1 : ms
}

// ---------------------------------------------------------------- 循环

const FRAME_MS = 1000 / 15
let last = 0
let acc = 0
let running = false

function loop(now) {
  if (!running) return
  requestAnimationFrame(loop)
  if (!last) last = now
  acc += now - last
  last = now
  if (acc < FRAME_MS) return
  const dt = Math.min(acc, 120) / 1000
  acc = 0
  step(dt)
  paint()
}

function startLoop() {
  if (running) return
  running = true
  last = 0
  acc = 0
  requestAnimationFrame(loop)
}

// ---------------------------------------------------------------- 点位

function localPoint(e) {
  const rect = canvas.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function cellAt(px, py) {
  return {
    c: Math.floor((px - layout.pad) / layout.cellW),
    r: Math.floor((py - layout.pad) / layout.cellH),
  }
}

function updateHover(pt) {
  const cell = cellAt(pt.x, pt.y)
  const inWater = cell.c >= 1 && cell.c <= COLS - 2 && cell.r >= WATER_TOP && cell.r <= WATER_BOTTOM
  model.cursor.x = cell.c
  model.cursor.y = cell.r
  model.cursor.inside = inWater
  model.cursor.stamp = model.t
  if (down && down.moved) {
    canvas.style.cursor = 'grabbing'
    return
  }
  canvas.style.cursor = inWater ? 'crosshair' : 'grab'
}

// ---------------------------------------------------------------- 喂食

function feedAt(px, py) {
  const { c, r } = cellAt(px, py)
  if (r < WATER_TOP || r > WATER_BOTTOM || c < 1 || c > COLS - 2) return false
  // 1~3 颗，位置各自散开：不想再排成整齐的一行
  const n = 1 + Math.floor(Math.random() * 3)
  for (let i = 0; i < n; i++) {
    spawnPellet(c + rand(-2.2, 2.2), r + rand(-1.2, 1.2))
  }
  model.stats.feeds++
  return true
}

function clickAt(px, py) {
  const { c, r } = cellAt(px, py)
  // 先看螃蟹：点它只夹你一下，不撒食
  if (crabAt(c, r)) {
    pinchCrab({ c, r })
    return false
  }
  const f = fishAt(c, r)
  if (f) {
    scareFish(f, { c, r })
    return false
  }
  return feedAt(px, py)
}

// ---------------------------------------------------------------- 菜单

const MENU_ITEMS = [
  { act: 'feed', label: '撒一把鱼食' },
  { act: 'add', label: '再加一条鱼' },
  { act: 'remove', label: '捞走一条鱼' },
  { sep: true },
  { act: 'size:small', label: '尺寸 · 小' },
  { act: 'size:medium', label: '尺寸 · 中' },
  { act: 'size:large', label: '尺寸 · 大' },
  { sep: true },
  { act: 'clear', label: '换水（清掉鱼食）' },
  { act: 'theme', label: '深色外壳', toggle: true },
  { act: 'top', label: '总在最前', toggle: true },
  { sep: true },
  { act: 'quit', label: '退出', danger: true },
]

function buildMenu() {
  menuEl.textContent = ''
  for (const item of MENU_ITEMS) {
    if (item.sep) {
      menuEl.appendChild(document.createElement('hr'))
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.act = item.act
    if (item.danger) btn.classList.add('is-danger')
    const label = document.createElement('span')
    label.textContent = item.label
    const tick = document.createElement('span')
    tick.className = 'tick'
    tick.textContent = '✓'
    btn.append(label, tick)
    menuEl.appendChild(btn)
  }
  menuEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    e.stopPropagation()
    runAction(btn.dataset.act)
  })
  refreshMenuState()
}

function refreshMenuState() {
  for (const btn of menuEl.querySelectorAll('button')) {
    const act = btn.dataset.act
    const on = (act === 'top' && model.alwaysOnTop) || (act === 'theme' && model.theme === 'dark')
    btn.classList.toggle('is-on', on)
  }
}

function openMenuAt(px, py) {
  if (!menuEl.childElementCount) buildMenu()
  refreshMenuState()
  model.menuOpen = true
  menuEl.hidden = false
  const w = menuEl.offsetWidth
  const h = menuEl.offsetHeight
  const left = clamp(px, 6, Math.max(6, view.w - w - 6))
  const top = clamp(py, 6, Math.max(6, view.h - h - 6))
  menuEl.style.left = Math.round(left) + 'px'
  menuEl.style.top = Math.round(top) + 'px'
}

function closeMenu() {
  if (!model.menuOpen) return
  model.menuOpen = false
  menuEl.hidden = true
}

function toggleMenuAt(px, py) {
  if (model.menuOpen) closeMenu()
  else openMenuAt(px, py)
}

function runAction(act) {
  if (!act) return
  if (act === 'feed') {
    for (let i = 0; i < 6; i++) spawnPellet(rand(4, COLS - 5), rand(WATER_TOP + 0.5, WATER_TOP + 3))
  } else if (act === 'add') {
    addFish()
    save()
  } else if (act === 'remove') {
    // 小丑鱼保底：捞走别的鱼，它留着
    for (let i = model.fish.length - 1; i >= 0; i--) {
      if (model.fish[i].temper !== 'clown') {
        model.fish.splice(i, 1)
        break
      }
    }
    save()
  } else if (act === 'clear') {
    model.pellets.length = 0
    for (let i = 0; i < 6; i++) spawnBubble(rand(3, COLS - 4), rand(WATER_TOP + 2, SEABED_ROW - 1))
  } else if (act === 'top') {
    model.alwaysOnTop = !model.alwaysOnTop
    window.aq.setTop(model.alwaysOnTop)
    refreshMenuState()
    return
  } else if (act === 'theme') {
    model.theme = model.theme === 'dark' ? 'clear' : 'dark'
    applyTheme()
    window.aq.setTheme(model.theme)
    refreshMenuState()
    return
  } else if (act.startsWith('size:')) {
    applySize(act.slice(5))
    return
  } else if (act === 'quit') {
    save()
    window.aq.quit()
    return
  }
  closeMenu()
}

// ---------------------------------------------------------------- 尺寸切换

async function applySize(name) {
  closeMenu()
  const next = await window.aq.setSize(name)
  layout = { ...layout, ...next }
  model.sizeName = name
  requestAnimationFrame(fitCanvas)
}

// ---------------------------------------------------------------- 输入

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  if (suppressPointer) {
    suppressPointer = false
    return
  }
  if (model.menuOpen) {
    closeMenu()
    return
  }
  const pt = localPoint(e)
  updateHover(pt)
  down = { sx: e.screenX, sy: e.screenY, x: pt.x, y: pt.y, moved: false }
  try {
    canvas.setPointerCapture(e.pointerId)
  } catch (err) {
    /* 指针捕获失败不影响拖动 */
  }
})

canvas.addEventListener('pointermove', (e) => {
  const pt = localPoint(e)
  updateHover(pt)
  if (!down || down.moved) return
  const dx = e.screenX - down.sx
  const dy = e.screenY - down.sy
  if (dx * dx + dy * dy >= DRAG_SQ) {
    down.moved = true
    closeMenu()
    canvas.style.cursor = 'grabbing'
    model.stats.dragStarts++
    window.aq.dragStart()
  }
})

canvas.addEventListener('pointerleave', () => {
  model.cursor.inside = false
})

function endPointer(e, cancelled) {
  if (!down) return
  try {
    canvas.releasePointerCapture(e.pointerId)
  } catch (err) {
    /* ignore */
  }
  const wasDrag = down.moved
  const { x, y, sx, sy } = down
  down = null
  if (wasDrag) {
    model.stats.dragEnds++
    window.aq.dragEnd()
    updateHover(localPoint(e))
    return
  }
  if (cancelled) return
  if (model.menuOpen) {
    closeMenu()
    return
  }
  const movedFar = (e.screenX - sx) ** 2 + (e.screenY - sy) ** 2 >= DRAG_SQ
  if (!movedFar) clickAt(x, y)
}

canvas.addEventListener('pointerup', (e) => endPointer(e, false))
canvas.addEventListener('pointercancel', (e) => endPointer(e, true))

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const pt = localPoint(e)
  toggleMenuAt(pt.x, pt.y)
})

// 点击菜单外面：收起菜单，并且这一下不再触发喂食
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!model.menuOpen) return
    if (e.target && e.target.closest && e.target.closest('#menu')) return
    closeMenu()
    suppressPointer = true
  },
  true,
)

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu()
})

window.addEventListener('blur', () => {
  closeMenu()
  model.cursor.inside = false
  if (down && down.moved) {
    down.moved = false
    window.aq.dragEnd()
  }
})

// ---------------------------------------------------------------- 存档

let saveTimer = null
function save() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  window.aq.save({
    satiety: Math.round(model.satiety * 10) / 10,
    fishCount: model.fish.length,
  })
}

function startAutosave() {
  setInterval(save, 5000)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) save()
  })
  window.addEventListener('beforeunload', save)
}

// ---------------------------------------------------------------- 启动

async function init() {
  const boot = await window.aq.load()
  layout = { ...layout, ...boot.layout }
  model.sizeName = boot.state.size || 'medium'
  model.theme = boot.state.theme === 'dark' ? 'dark' : 'clear'
  applyTheme()
  model.alwaysOnTop = boot.state.alwaysOnTop !== false

  // 离线也照常会饿：按存档时间补算衰减
  const savedAt = Number(boot.state.savedAt) || Date.now()
  const offlineMin = Math.max(0, (Date.now() - savedAt) / 60000)
  const carried = clamp(Number(boot.state.satiety) || 0, 0, 100)
  model.satiety = clamp(carried - offlineMin * (100 / (5 * 60)), 0, 100)

  const wantFish = clamp(Number(boot.state.fishCount) || 3, 1, 8)
  addFish(true) // 保底一条小丑鱼
  while (model.fish.length < wantFish) addFish()

  seedDust()
  seedPlants()
  // 螃蟹每次开机换个落脚点，别老在同一个位置
  model.crab.x = rand(2.5, CRAB.maxX - 1)
  for (let i = 0; i < 4; i++) spawnBubble(rand(3, COLS - 4), rand(WATER_TOP + 2, WATER_BOTTOM))

  fitCanvas()
  // 尺寸可能被外部改（菜单、屏幕缩放、改 DPI）：每次 resize 都重新问一次布局，
  // 否则画布还按旧格子画，会出现"大图被窗口裁掉"的样子
  window.addEventListener('resize', async () => {
    try {
      const again = await window.aq.load()
      layout = { ...layout, ...again.layout }
    } catch (err) {
      /* 拿不到就按当前布局硬重排 */
    }
    fitCanvas()
  })
  paint()
  startLoop()
  startAutosave()

  // 截图/自检用的把手
  window.__aq = {
    feedAt: (x, y) => feedAt(x, y),
    clickAt: (x, y) => clickAt(x, y),
    openMenuAt: (x, y) => openMenuAt(x, y),
    setSize: (name) => applySize(name),
    addFish: () => addFish(),
    runAction: (act) => runAction(act),
    /** 自检用：按固定步长推进 n 帧，不依赖 wall clock（窗口被遮挡时 rAF 会被节流） */
    stepSim: (n, dt) => {
      const d = dt || 1 / 15
      for (let i = 0; i < n; i++) step(d)
      return n
    },
    mouthOf: (f) => fishMouth(f),
    crab: () => model.crab,
    teasing: () => teasingCrab(),
    repaint: () => paint(),
    closeMenu,
    model,
    layout: () => layout,
    dump: () => {
      const lines = []
      for (let r = 0; r < ROWS; r++) lines.push(bufCh.slice(r * COLS, (r + 1) * COLS).join(''))
      return lines.join('\n')
    },
    metrics: () => {
      const ink = (ch) => {
        const m = ctx.measureText(ch)
        return {
          adv: Number(m.width.toFixed(2)),
          ink: Number(((m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0)).toFixed(2)),
        }
      }
      return {
        ctxFont: ctx.font,
        cellW: layout.cellW,
        cellH: layout.cellH,
        glyphs: { M: ink('M'), block: ink('▓'), dot: ink('·') },
      }
    },
  }
}

init().catch((err) => {
  console.error(err)
})
