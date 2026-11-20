// 鱼的品种 / 外形 / 配色数据。
// 品种决定行为；品种允许的 body 决定能长什么样；颜色与 body 无关。
window.AQ_DATA = {
  SPECIES: {
    clown: {
      base: 2.4,
      greed: 1.25,
      color: '#ff5a00',
      paint: 'clown',
      bodies: ['clown-standard'],
      defaultBody: 'clown-standard',
    },
    shy: {
      base: 2.6,
      greed: 0.8,
      color: '#6ef9ff',
      bodies: ['shy-needle'],
      defaultBody: 'shy-needle',
    },
    still: {
      base: 2.2,
      greed: 1.0,
      color: '#ff8ada',
      bodies: ['still-round'],
      defaultBody: 'still-round',
    },
    calm: {
      base: 1.9,
      greed: 0.95,
      color: '#ffe28a',
      bodies: ['calm-long', 'calm-curl'],
      defaultBody: 'calm-long',
    },
  },

  BODIES: {
    'clown-standard': { chars: '><(((·>' },
    'shy-needle': { chars: '><>' },
    'still-round': { chars: '><°>' },
    'calm-long': { chars: '><(((·>' },
    'calm-curl': { chars: '><@((>' },
  },

  // 跟体长有关的生理/物理参数统一放这里；新增字段先加表，再由 bodySizeFor() 取。
  BODY_SIZE: {
    2: { food: [2, 3], sleepK: 0.6, dropK: 0.5, glowK: 0.61, waterK: 1.05 },
    3: { food: [4, 5], sleepK: 0.7, dropK: 0.55, glowK: 0.69, waterK: 1.0 },
    4: { food: [4, 5], sleepK: 0.8, dropK: 0.68, glowK: 0.77, waterK: 0.9 },
    5: { food: [3, 4], sleepK: 0.9, dropK: 0.81, glowK: 0.85, waterK: 0.8 },
    6: { food: [3, 4], sleepK: 1.0, dropK: 0.94, glowK: 0.93, waterK: 0.72 },
    7: { food: [2, 3], sleepK: 1.1, dropK: 1.07, glowK: 1.01, waterK: 0.64 },
    8: { food: [2, 3], sleepK: 1.2, dropK: 1.15, glowK: 1.05, waterK: 0.56 },
    9: { food: [2, 3], sleepK: 1.3, dropK: 1.15, glowK: 1.05, waterK: 0.5 },
    10: { food: [2, 3], sleepK: 1.3, dropK: 1.15, glowK: 1.05, waterK: 0.46 },
  },
  LOOKS: {
    // 六成彩色、四成单色；重复项就是权重
    styles: ['duo', 'duo', 'rainbow', 'mono', 'mono'],
    paints: ['clown', 'duo', 'rainbow', 'mono'],
    accents: ['#ff8ada', '#ffe28a', '#8affd0', '#b7a4ff', '#ff9f6e'],
    rainbow: ['#6ef9ff', '#8affd0', '#ffe28a', '#ff8ada', '#b7a4ff'],
    clownBands: ['#ff2d00', '#ffe9a8', '#ff5a00', '#ff7a00', '#ffe9a8', '#240800', '#ff8a1f'],
  },
}
