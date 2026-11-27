import type { ReactNode } from 'react'
import { EditorFontsScope } from '@/components/platform-shell/EditorFontsScope'

export default function RenderLayout({ children }: { children: ReactNode }) {
  return <EditorFontsScope>{children}</EditorFontsScope>
}
