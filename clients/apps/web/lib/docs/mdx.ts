import * as jsxRuntime from 'react/jsx-runtime'
import type { ComponentType } from 'react'
import type { DocsSourcePage } from './source'

export type CompiledMdxComponent = ComponentType<{
  components?: Record<string, unknown>
}>

const compiledMdxCache = new Map<string, Promise<CompiledMdxComponent>>()

/**
 * Compiles and caches an MDX docs page using Fumadocs Shiki code highlighting,
 * GitHub-flavored Markdown, and heading anchors. Uses dynamic ESM imports so
 * the same module runs cleanly in both Next.js RSC and `tsx --test`.
 */
export function compileDocsMdx(page: DocsSourcePage): Promise<CompiledMdxComponent> {
  const cacheKey = `${page.url}:${page.data.content.length}`
  if (process.env.NODE_ENV !== 'development') {
    const cached = compiledMdxCache.get(cacheKey)
    if (cached) return cached
  }

  const compilation = (async () => {
    const [{ evaluate }, { rehypeCode, remarkGfm, remarkHeading }] = await Promise.all([
      import('@mdx-js/mdx'),
      import('fumadocs-core/mdx-plugins'),
    ])
    const result = await evaluate(page.data.content, {
      ...jsxRuntime,
      development: false,
      rehypePlugins: [
        [
          rehypeCode,
          {
            themes: {
              dark: 'github-dark',
              light: 'github-light',
            },
          },
        ],
      ],
      remarkPlugins: [remarkGfm, remarkHeading],
    })
    return result.default as CompiledMdxComponent
  })().catch((error: unknown) => {
    compiledMdxCache.delete(cacheKey)
    throw error
  })

  if (process.env.NODE_ENV !== 'development') {
    compiledMdxCache.set(cacheKey, compilation)
  }

  return compilation
}
