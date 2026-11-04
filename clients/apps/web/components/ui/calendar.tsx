'use client'

import { CaretLeftIcon as ChevronLeft } from '@phosphor-icons/react/dist/ssr/CaretLeft'
import { CaretRightIcon as ChevronRight } from '@phosphor-icons/react/dist/ssr/CaretRight'
import type * as React from 'react'
import { DayPicker } from 'react-day-picker'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** A month calendar (react-day-picker 9) in the app's design. */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      className={cn('p-3', className)}
      classNames={{
        button_next: cn(buttonVariants({ variant: 'ghost' }), 'size-7 p-0'),
        button_previous: cn(buttonVariants({ variant: 'ghost' }), 'size-7 p-0'),
        caption_label: 'text-ui-lg font-medium',
        day: 'size-9 p-0 text-center text-sm',
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-9 p-0 font-normal aria-selected:opacity-100'
        ),
        disabled: 'text-muted-foreground opacity-50',
        hidden: 'invisible',
        month: 'flex flex-col gap-3',
        month_caption: 'flex h-7 items-center justify-center',
        month_grid: 'w-full border-collapse',
        months: 'relative flex flex-col gap-4 sm:flex-row',
        nav: 'absolute inset-x-0 top-0 flex items-center justify-between',
        outside: 'text-muted-foreground opacity-50',
        root: 'w-fit',
        selected:
          '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground',
        today: '[&>button]:bg-accent [&>button]:text-accent-foreground',
        week: 'mt-1 flex w-full',
        weekday: 'w-9 text-[0.8rem] font-normal text-muted-foreground',
        weekdays: 'flex',
        ...classNames,
      }}
      components={{
        Chevron: ({ className: chevronClass, orientation }) =>
          orientation === 'left' ? (
            <ChevronLeft className={cn('size-4', chevronClass)} />
          ) : (
            <ChevronRight className={cn('size-4', chevronClass)} />
          ),
      }}
      showOutsideDays={showOutsideDays}
      {...props}
    />
  )
}

export { Calendar }
