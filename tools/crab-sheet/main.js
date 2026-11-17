// 一次性工具：把几种螃蟹画法渲染成一张对比图，截完就退出
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.whenReady().then(async () => {
  const htmlArg = process.argv.find((a) => a.startsWith('--html='))
  const html = htmlArg ? path.resolve(htmlArg.slice('--html='.length)) : path.join(__dirname, 'index.html')
  const sizeArg = process.argv.find((a) => a.startsWith('--size='))
  const size = sizeArg ? sizeArg.slice('--size='.length).split('x').map(Number) : [960, 960]
  const win = new BrowserWindow({
    width: size[0],
    height: size[1],
    useContentSize: true,
    show: true,
    frame: false,
    backgroundColor: '#0a1a1e',
  })
  await win.loadFile(html)
  await new Promise((r) => setTimeout(r, 700))
  console.log('pageerr ' + (await win.webContents.executeJavaScript('window.__err || "missing"')))
  const img = await win.webContents.capturePage()
  const arg = process.argv.find((a) => a.startsWith('--out='))
  const target = arg ? arg.slice('--out='.length) : path.join(__dirname, '..', '..', 'shots', 'crabs.png')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, img.toPNG())
  console.log('captured ' + target)
  app.quit()
})
