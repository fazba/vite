import fs from 'node:fs'
import path from 'node:path'
import type { Server } from 'node:http'
import colors from 'picocolors'
import type { Update } from 'types/hmrPayload'
import type { RollupError } from 'rollup'
import { CLIENT_DIR } from '../constants'
import { createDebugger, normalizePath, unique } from '../utils'
import type { ViteDevServer } from '..'
import { isCSSRequest } from '../plugins/css'
import { getAffectedGlobModules } from '../plugins/importMetaGlob'
import { isExplicitImportRequired } from '../plugins/importAnalysis'
import type { ModuleNode } from './moduleGraph'

export const debugHmr = createDebugger('vite:hmr')

const normalizedClientDir = normalizePath(CLIENT_DIR)

export interface HmrOptions {
  protocol?: string
  host?: string
  port?: number
  clientPort?: number
  path?: string
  timeout?: number
  overlay?: boolean
  server?: Server
}

export interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

export function getShortName(file: string, root: string): string {
  return file.startsWith(root + '/') ? path.posix.relative(root, file) : file
}

export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer
): Promise<void> {
  const { ws, config, moduleGraph } = server
  const shortFile = getShortName(file, config.root) // 获取简短文件名
  const fileName = path.basename(file)
  // 判断配置文件修改，比如 vite.config.ts
  const isConfig = file === config.configFile
  // 判断配置文件的依赖
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name
  )
  // 判断环境变量文件
  const isEnv =
    config.inlineConfig.envFile !== false &&
    (fileName === '.env' || fileName.startsWith('.env.'))
  if (isConfig || isConfigDependency || isEnv) {
    // auto restart server  （直接重启服务）
    debugHmr(`[config change] ${colors.dim(shortFile)}`)
    config.logger.info(
      colors.green(
        `${path.relative(process.cwd(), file)} changed, restarting server...`
      ),
      { clear: true, timestamp: true }
    )
    try {
      await server.restart()
    } catch (e) {
      config.logger.error(colors.red(e))
    }
    return
  }

  debugHmr(`[file change] ${colors.dim(shortFile)}`)

  // (dev only) the client itself cannot be hot updated.  （vite 的 client 修改了，全量刷新 -> 刷新页面）
  if (file.startsWith(normalizedClientDir)) {
    ws.send({
      type: 'full-reload',
      path: '*'
    })
    return
  }
  // 获取文件关联的模块
  const mods = moduleGraph.getModulesByFile(file)

  // check if any plugin wants to perform custom HMR handling
  const timestamp = Date.now()
  const hmrContext: HmrContext = {
    file,
    timestamp,
    modules: mods ? [...mods] : [], // 受更改文件影响的模块数组
    // 这是一个异步读函数，它返回文件的内容。之所以这样做，是因为在某些系统上，文件更改的回调函数可能会在编辑器完成文件更新之前过快地触发并 fs.readFile 直接会返回空内容。传入的 read 函数规范了这种行为。
    read: () => readModifiedFile(file),
    server
  }
  // 遍历插件，调用 handleHotUpdate 钩子
  for (const hook of config.getSortedPluginHooks('handleHotUpdate')) {
    /**受更改文件影响的模块数组 */
    const filteredModules = await hook(hmrContext)
    if (filteredModules) {
      hmrContext.modules = filteredModules
    }
  }
  // 文件修改没有影响其他模块
  if (!hmrContext.modules.length) {
    // html file cannot be hot updated  （是 html 的话，直接刷新页面）
    if (file.endsWith('.html')) {
      config.logger.info(colors.green(`page reload `) + colors.dim(shortFile), {
        clear: true,
        timestamp: true
      })
      ws.send({
        type: 'full-reload',
        path: config.server.middlewareMode
          ? '*'
          : '/' + normalizePath(path.relative(config.root, file))
      })
    } else {
      // loaded but not in the module graph, probably not js
      debugHmr(`[no modules matched] ${colors.dim(shortFile)}`)
    }
    return
  }
  // 核心，执行模块更新
  updateModules(shortFile, hmrContext.modules, timestamp, server)
}

export function updateModules(
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  { config, ws }: ViteDevServer
): void {
  const updates: Update[] = []
  const invalidatedModules = new Set<ModuleNode>()
  /**页面刷新符号 */
  let needFullReload = false

  for (const mod of modules) {
    invalidate(mod, timestamp, invalidatedModules)
    // 如果需要重新刷新，不再去计算边界
    if (needFullReload) {
      continue
    }

    const boundaries = new Set<{
      boundary: ModuleNode
      acceptedVia: ModuleNode
    }>()
    /**死路标志 */
    const hasDeadEnd = propagateUpdate(mod, boundaries)
    // 死路的话直接刷新页面
    if (hasDeadEnd) {
      needFullReload = true
      continue
    }
    // 否则的话，遍历全部边界，触发模块更新
    updates.push(
      ...[...boundaries].map(({ boundary, acceptedVia }) => ({
        type: `${boundary.type}-update` as const,
        timestamp,
        path: boundary.url,
        explicitImportRequired:
          boundary.type === 'js'
            ? isExplicitImportRequired(acceptedVia.url)
            : undefined,
        acceptedPath: acceptedVia.url
      }))
    )
  }

  if (needFullReload) {
    config.logger.info(colors.green(`page reload `) + colors.dim(file), {
      clear: true,
      timestamp: true
    })
    ws.send({
      type: 'full-reload'
    })
    return
  }

  if (updates.length === 0) {
    debugHmr(colors.yellow(`no update happened `) + colors.dim(file))
    return
  }

  config.logger.info(
    updates
      .map(({ path }) => colors.green(`hmr update `) + colors.dim(path))
      .join('\n'),
    { clear: true, timestamp: true }
  )
  ws.send({
    type: 'update',
    updates
  })
}

export async function handleFileAddUnlink(
  file: string,
  server: ViteDevServer
): Promise<void> {
  const modules = [...(server.moduleGraph.getModulesByFile(file) || [])]

  modules.push(...getAffectedGlobModules(file, server))

  if (modules.length > 0) {
    updateModules(
      getShortName(file, server.config.root),
      unique(modules),
      Date.now(),
      server
    )
  }
}

function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false
    }
  }
  return true
}

function propagateUpdate(
  node: ModuleNode,
  boundaries: Set<{
    boundary: ModuleNode
    acceptedVia: ModuleNode
  }>,
  currentChain: ModuleNode[] = [node]
): boolean /* hasDeadEnd */ {
  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id
      )}`
    )
    return false
  }
  // 如果模块自我“接受”，加入到边界数组中
  if (node.isSelfAccepting) {
    boundaries.add({
      boundary: node,
      acceptedVia: node
    })

    // additionally check for CSS importers, since a PostCSS plugin like
    // Tailwind JIT may register any file as a dependency to a CSS file.
    // 将 css 相关的资源引入全部加到 boundaries
    for (const importer of node.importers) {
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        propagateUpdate(importer, boundaries, currentChain.concat(importer))
      }
    }

    return false
  }

  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  if (node.acceptedHmrExports) {
    boundaries.add({
      boundary: node,
      acceptedVia: node
    })
  } else {
    if (!node.importers.size) {
      return true
    }

    // #3716, #3913
    // For a non-CSS file, if all of its importers are CSS files (registered via
    // PostCSS plugins) it should be considered a dead end and force full reload.
    if (
      !isCSSRequest(node.url) &&
      [...node.importers].every((i) => isCSSRequest(i.url))
    ) {
      return true
    }
  }

  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)
    if (importer.acceptedHmrDeps.has(node)) {
      boundaries.add({
        boundary: importer,
        acceptedVia: node
      })
      continue
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue
      }
    }

    if (currentChain.includes(importer)) {
      // circular deps is considered dead end   (循环引用直接刷新)
      return true
    }

    if (propagateUpdate(importer, boundaries, subChain)) {
      return true
    }
  }
  return false
}

function invalidate(mod: ModuleNode, timestamp: number, seen: Set<ModuleNode>) {
  if (seen.has(mod)) {
    return
  }
  seen.add(mod)
  mod.lastHMRTimestamp = timestamp
  // 置空一系列信息
  mod.transformResult = null
  mod.ssrModule = null
  mod.ssrError = null
  mod.ssrTransformResult = null
  mod.importers.forEach((importer) => {
    // 当模块热更的依赖不包含当前模块，也就是 accept 的参数是空时就清空引用者的信息
    if (!importer.acceptedHmrDeps.has(mod)) {
      invalidate(importer, timestamp, seen)
    }
  })
}

export function handlePrunedModules(
  mods: Set<ModuleNode>,
  { ws }: ViteDevServer
): void {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = Date.now()
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t
    debugHmr(`[dispose] ${colors.dim(mod.file)}`)
  })
  ws.send({
    type: 'prune',
    paths: [...mods].map((m) => m.url)
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 *
 * @returns selfAccepts
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>
): boolean {
  let state: LexerState = LexerState.inCall
  // the state can only be 2 levels deep so no need for a stack
  let prevState: LexerState = LexerState.inCall
  let currentDep: string = ''

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1
    })
    currentDep = ''
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (/\s/.test(char)) {
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              return true // done
            }
          } else if (state === LexerState.inArray) {
            if (char === `]`) {
              return false // done
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown import.meta.hot lexer state')
    }
  }
  return false
}

export function lexAcceptedHmrExports(
  code: string,
  start: number,
  exportNames: Set<string>
): boolean {
  const urls = new Set<{ url: string; start: number; end: number }>()
  lexAcceptedHmrDeps(code, start, urls)
  for (const { url } of urls) {
    exportNames.add(url)
  }
  return urls.size > 0
}

function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
      `Array of string literals.`
  ) as RollupError
  err.pos = pos
  throw err
}

// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
async function readModifiedFile(file: string): Promise<string> {
  const content = fs.readFileSync(file, 'utf-8')
  if (!content) {
    const mtime = fs.statSync(file).mtimeMs
    await new Promise((r) => {
      let n = 0
      const poll = async () => {
        n++
        const newMtime = fs.statSync(file).mtimeMs
        if (newMtime !== mtime || n > 10) {
          r(0)
        } else {
          setTimeout(poll, 10)
        }
      }
      setTimeout(poll, 10)
    })
    return fs.readFileSync(file, 'utf-8')
  } else {
    return content
  }
}
