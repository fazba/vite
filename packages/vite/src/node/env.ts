import fs from 'node:fs'
import dotenv from 'dotenv'
import dotenvExpand from 'dotenv-expand'
import { arraify, lookupFile } from './utils'
import type { UserConfig } from './config'

export function loadEnv(
  mode: string,
  envDir: string,
  prefixes: string | string[] = 'VITE_'
): Record<string, string> {
  // local 是 vite 内置的后缀名，比如 .env.development.local、.env.local，所以不给用
  if (mode === 'local') {
    throw new Error(
      `"local" cannot be used as a mode name because it conflicts with ` +
        `the .local postfix for .env files.`
    )
  }
  prefixes = arraify(prefixes)
  const env: Record<string, string> = {}
  // 默认会去读取的环境变量文件
  const envFiles = [
    /** mode local file */ `.env.${mode}.local`,
    /** mode file */ `.env.${mode}`,
    /** local file */ `.env.local`,
    /** default file */ `.env`
  ]

  // check if there are actual env variables starting with VITE_*
  // these are typically provided inline and should be prioritized
  //（ 通过CLI参数定义的一些环境变量中，如果带有 VITE 前缀，我们也能够从 import.meta.env 上获取到）
  for (const key in process.env) {
    if (
      prefixes.some((prefix) => key.startsWith(prefix)) &&
      env[key] === undefined
    ) {
      env[key] = process.env[key] as string
    }
  }

  for (const file of envFiles) {
    const path = lookupFile(envDir, [file], { pathOnly: true, rootDir: envDir })
    if (path) {
      const parsed = dotenv.parse(fs.readFileSync(path), {
        debug: process.env.DEBUG?.includes('vite:dotenv') || undefined
      })

      // let environment variables use each other
      dotenvExpand({
        parsed,
        // prevent process.env mutation
        ignoreProcessEnv: true
      } as any)

      // only keys that start with prefix are exposed to client
      for (const [key, value] of Object.entries(parsed)) {
        if (
          prefixes.some((prefix) => key.startsWith(prefix)) &&
          env[key] === undefined
        ) {
          env[key] = value
        } else if (
          key === 'NODE_ENV' &&
          process.env.VITE_USER_NODE_ENV === undefined
        ) {
          // NODE_ENV override in .env file
          process.env.VITE_USER_NODE_ENV = value
        }
      }
    }
  }
  return env
}

export function resolveEnvPrefix({
  envPrefix = 'VITE_'
}: UserConfig): string[] {
  envPrefix = arraify(envPrefix)
  // 如果定义了空的环境变量前缀，那么就能直接获取整个 process 的环境变量，这是危险的操作，所以给了一个敏感信息的提示
  if (envPrefix.some((prefix) => prefix === '')) {
    throw new Error(
      `envPrefix option contains value '', which could lead unexpected exposure of sensitive information.`
    )
  }
  return envPrefix
}
