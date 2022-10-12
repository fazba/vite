import type { InferCustomEventPayload } from './customEvent'

export type ModuleNamespace = Record<string, any> & {
  [Symbol.toStringTag]: 'Module'
}

export interface ViteHotContext {
  readonly data: any
  // 热更接收的模块，有四种定义：
  accept(): void //没有参数，代表接收自身
  accept(cb: (mod: ModuleNamespace | undefined) => void): void // mod是更新后的模块信息
  accept(dep: string, cb: (mod: ModuleNamespace | undefined) => void): void // 监听单个依赖 dep 的更新
  accept(
    deps: readonly string[],
    cb: (mods: Array<ModuleNamespace | undefined>) => void
  ): void // 监听多个依赖 deps 的更新

  acceptExports(exportNames: string | readonly string[]): void
  acceptExports(
    exportNames: string | readonly string[],
    cb: (mod: ModuleNamespace | undefined) => void
  ): void

  dispose(cb: (data: any) => void): void // 清除任何更新导致的持久副作用
  decline(): void
  invalidate(): void // 调用后直接刷新页面
  /**模块监听热更事件 */
  on<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void
  ): void
  send<T extends string>(event: T, data?: InferCustomEventPayload<T>): void
}
