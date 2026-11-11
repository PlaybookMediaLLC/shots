import { Combobox } from '@/components/ui/combobox'

export interface SearchableSelectOption {
  value: string
  label: string
  detail?: string
}

/** Original language and timezone choices rendered by Shots' searchable select. */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  className,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
}: {
  value: string
  onChange: (value: string) => void
  options: SearchableSelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  className?: string
  dropdownClassName?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <Combobox
      value={value}
      onValueChange={onChange}
      options={options.map((option) => ({ ...option, description: option.detail }))}
      valueLabel={selected?.detail ? `${selected.label} (${selected.detail})` : selected?.label}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyMessage}
      className={className}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    />
  )
}
