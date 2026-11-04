import Link from 'next/link'

/** The actual writing precedence; visual tokens and product facts have separate jobs. */
export function WritingInheritance() {
  return (
    <aside className="rounded-xl border border-border p-4 text-sm">
      <p className="font-medium">
        Workspace defaults → Publishing brand overrides → Draft-specific instructions
      </p>
      <p className="mt-2 text-muted-foreground">
        <Link className="underline" href="/settings/product">
          Product profile
        </Link>{' '}
        supplies product facts for release content.{' '}
        <Link className="underline" href="/settings/brand-kit">
          Brand voice
        </Link>{' '}
        sets the writing tone and audience; brand kits set visual style. A publishing brand’s Writing
        Assistant replaces tone and audience only where an override is entered. Instructions in a
        draft refine that draft. Prohibited terms always apply.
      </p>
    </aside>
  )
}
