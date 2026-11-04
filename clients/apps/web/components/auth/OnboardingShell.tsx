import { publicImageUrl } from '@/lib/assets/public-image'
import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import Image from 'next/image'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type OnboardingStep = { description: string; title: string }

/** The onboarding steps, in order: account, workspace, plan, product. */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  { description: 'Your sign-in details.', title: 'Create your account' },
  { description: "Your team's shared home.", title: 'Create your workspace' },
  { description: 'Pick how often you ship.', title: 'Choose a plan' },
  { description: 'Your first seven posts.', title: 'Your product' },
]

/**
 * Onboarding after Polar's: a framed split screen with the steps on the left
 * and the current step's panel on the right. Steps before `current` show as
 * done. On small screens the step list becomes a row of progress bars.
 */
export function OnboardingShell({
  children,
  current,
  footer,
  steps,
}: {
  children: ReactNode
  current: number
  footer?: ReactNode
  steps: OnboardingStep[]
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#090909] p-2 text-white md:p-6">
      <div className="flex min-h-[calc(100dvh-1rem)] w-full rounded-2xl border border-[#1c1c1c] bg-[#111111] p-2 md:h-[80dvh] md:min-h-0 md:w-[80vw]">
        <aside className="hidden w-72 shrink-0 flex-col justify-between p-6 md:flex">
          <div className="flex flex-col gap-10">
            <div className="flex items-center gap-2.5">
              <Image
                alt=""
                className="size-7 rounded-lg"
                height={28}
                src={publicImageUrl('/logo-mark.png')}
                width={28}
              />
              <span className="text-ui-lg font-semibold tracking-tight">Shots</span>
            </div>
            <ol className="flex flex-col gap-6">
              {steps.map((step, index) => {
                const done = index < current
                const active = index === current
                return (
                  <li className="flex gap-3" key={step.title}>
                    <span
                      aria-hidden
                      className={cn(
                        'grid size-8 shrink-0 place-items-center rounded-full text-xs font-medium',
                        done || active
                          ? 'bg-white text-black'
                          : 'border border-white/[0.12] text-neutral-500'
                      )}
                    >
                      {done ? <Check className="size-3.5" /> : index + 1}
                    </span>
                    <span className="pt-1">
                      <span
                        className={cn(
                          'block text-ui-lg font-medium',
                          active ? 'text-white' : done ? 'text-neutral-300' : 'text-neutral-500'
                        )}
                      >
                        {step.title}
                        <span className="sr-only">
                          {done ? ' (done)' : active ? ' (current step)' : ''}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs text-neutral-500">
                        {step.description}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ol>
          </div>
          {footer ? <div className="text-xs text-neutral-500">{footer}</div> : null}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded-xl border border-[#1c1c1c] bg-[#090909]">
          <div aria-hidden className="flex gap-1.5 px-4 pt-4 md:hidden">
            {steps.map((step, index) => (
              <span
                className={cn(
                  'h-0.5 flex-1 rounded-full',
                  index <= current ? 'bg-white' : 'bg-white/[0.12]'
                )}
                key={step.title}
              />
            ))}
          </div>
          {footer ? (
            <div className="px-4 pt-3 text-xs text-neutral-500 md:hidden">{footer}</div>
          ) : null}
          {children}
        </section>
      </div>
    </main>
  )
}
