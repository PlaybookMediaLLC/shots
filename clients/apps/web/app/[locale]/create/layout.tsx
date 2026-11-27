import type { ReactNode } from 'react'
import { EditorFontsScope } from '@/components/platform-shell/EditorFontsScope'

export default function CreateLayout({ children }: { children: ReactNode }) {
  return <EditorFontsScope>{children}</EditorFontsScope>
}
