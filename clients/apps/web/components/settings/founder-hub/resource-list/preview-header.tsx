// Ported from apps/desktop/src/shared/ui/resource-list/preview-header.tsx; see dev/import-founder-hub-ui.mjs.
import { useLingui as _useLingui } from '@lingui/react'
import type { ComponentProps, ReactNode } from 'react'
import { Copy } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { getTemplateCreatorLabel } from '../templates/utils'
export function ResourcePreviewHeader({
  icon,
  title,
  description,
  targets,
  onClone,
  actionLabel,
  actionIcon,
  actionVariant,
  actionClassName,
  actions,
  titleMeta,
  footer,
  children,
}: {
  icon?: ReactNode
  title: string
  description?: string | null
  targets?: string[] | null
  onClone?: () => void
  actionLabel?: string
  actionIcon?: ReactNode
  actionVariant?: ComponentProps<typeof Button>['variant']
  actionClassName?: string
  actions?: ReactNode
  titleMeta?: ReactNode
  footer?: ReactNode
  children?: ReactNode
}) {
  const { _: _t } = _useLingui()
  const actionButton = onClone ? (
    <Button onClick={onClone} size="sm" variant={actionVariant} className={actionClassName}>
      {actionIcon === undefined ? <Copy className="mr-2 h-4 w-4" /> : actionIcon}
      {actionLabel ??
        _t(
          /*i18n*/
          {
            id: '9UQ730',
            message: 'Clone',
          }
        )}
    </Button>
  ) : null
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center justify-between gap-3 pr-1 pl-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {icon}
          <h2 className="min-w-0 truncate text-sm font-semibold">
            {title ||
              _t(
                /*i18n*/
                {
                  id: 'wja8aL',
                  message: 'Untitled',
                }
              )}
          </h2>
          {titleMeta}
        </div>
        <div className="flex items-center gap-0">
          {actions}
          {actionButton}
        </div>
      </div>

      <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto px-6 pt-3 pb-6">
        <div className="min-w-0">
          {description && (
            <p className="text-muted-foreground min-h-[24px] text-sm">{description}</p>
          )}
          {targets && targets.length > 0 && (
            <div className="mt-2 flex min-h-6 flex-wrap items-center gap-1.5">
              {targets.map((target, index) => (
                <span
                  key={index}
                  className="bg-muted text-muted-foreground inline-flex h-6 items-center rounded-md px-2 py-0.5 text-xs"
                >
                  {target}
                </span>
              ))}
            </div>
          )}
          {footer === undefined ? (
            <p className="text-muted-foreground mt-2 text-xs">
              {getTemplateCreatorLabel({
                isUserTemplate: false,
              })}
            </p>
          ) : (
            footer
          )}
        </div>
        {children}
      </div>
    </div>
  )
}
