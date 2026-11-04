'use client'

import type { AutomationCondition } from '@/lib/api/contracts/release-automation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

export const automationSelectClass =
  'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm'

const operatorLabels: Record<string, string> = {
  eq: 'Equals',
  ne: 'Does not equal',
  in: 'In',
  not_in: 'Not in',
  contains: 'Contains',
  not_contains: 'Does not contain',
  starts_with: 'Starts with',
  glob: 'Matches glob',
  exists: 'Exists',
  not_exists: 'Does not exist',
  is_true: 'Is true',
  is_false: 'Is false',
  gt: 'Greater than',
  gte: 'At least',
  lt: 'Less than',
  lte: 'At most',
}

/** Only fields supplied by the backend's selected-event catalog are offered. */
export function ConditionEditor({
  value,
  fields,
  onChange,
  label,
  depth = 1,
}: {
  value: AutomationCondition
  fields: Record<string, string>
  onChange: (value: AutomationCondition) => void
  label: string
  depth?: number
}) {
  const field = value.field ?? Object.keys(fields)[0] ?? 'repository.id'
  const boolean = fields[field] === 'boolean'
  const operators = boolean
    ? ['is_true', 'is_false', 'exists', 'not_exists']
    : fields[field] === 'number'
      ? ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists']
      : [
          'eq',
          'ne',
          'in',
          'not_in',
          'contains',
          'not_contains',
          'starts_with',
          'glob',
          'exists',
          'not_exists',
        ]
  const predicate = (): AutomationCondition => ({
    field: Object.keys(fields)[0] ?? 'repository.id',
    operator: 'exists',
  })
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-ui-lg font-medium">{label}</legend>
      <Label className="grid gap-1 text-sm">
        Match logic
        <Select
          value={value.group ?? 'predicate'}
          onValueChange={(nextValue) => {
            const group = nextValue
            onChange(
              group === 'predicate'
                ? predicate()
                : { group: group as 'ALL' | 'ANY' | 'NOT', children: [predicate()] }
            )
          }}
        >
          <SelectTrigger aria-label={`${label} match logic`} className={automationSelectClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="predicate">One condition</SelectItem>
            <SelectItem value="ALL">ALL conditions</SelectItem>
            <SelectItem value="ANY">ANY condition</SelectItem>
            <SelectItem value="NOT">NOT this condition</SelectItem>
          </SelectContent>
        </Select>
      </Label>
      {value.group ? (
        <>
          {(value.children ?? []).map((child, index) => (
            <div key={index} className="space-y-2">
              <ConditionEditor
                value={child}
                fields={fields}
                label={`${label} ${index + 1}`}
                depth={depth + 1}
                onChange={(next) =>
                  onChange({
                    ...value,
                    children: value.children?.map((item, childIndex) =>
                      childIndex === index ? next : item
                    ),
                  })
                }
              />
              {value.group !== 'NOT' && (value.children?.length ?? 0) > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onChange({
                      ...value,
                      children: value.children?.filter((_, childIndex) => childIndex !== index),
                    })
                  }
                >
                  Remove condition {index + 1}
                </Button>
              ) : null}
            </div>
          ))}
          {value.group !== 'NOT' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={depth >= 8 || (value.children?.length ?? 0) >= 32}
              onClick={() =>
                onChange({ ...value, children: [...(value.children ?? []), predicate()] })
              }
            >
              Add condition
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <Label className="grid gap-1 text-sm">
            Field
            <Select
              value={field}
              onValueChange={(nextValue) =>
                onChange({
                  field: nextValue,
                  operator: fields[nextValue] === 'boolean' ? 'is_true' : 'exists',
                })
              }
            >
              <SelectTrigger aria-label={`${label} field`} className={automationSelectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(fields).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <Label className="grid gap-1 text-sm">
            Operator
            <Select
              value={value.operator ?? 'exists'}
              onValueChange={(nextValue) => {
                const operator = nextValue
                onChange({
                  field,
                  operator,
                  ...(['exists', 'not_exists', 'is_true', 'is_false'].includes(operator)
                    ? {}
                    : { values: value.values ?? [''] }),
                })
              }}
            >
              <SelectTrigger aria-label={`${label} operator`} className={automationSelectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {operators.map((operator) => (
                  <SelectItem key={operator} value={operator}>
                    {operatorLabels[operator]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          {!['exists', 'not_exists', 'is_true', 'is_false'].includes(value.operator ?? 'exists') ? (
            <Label className="grid gap-1 text-sm">
              {['in', 'not_in'].includes(value.operator ?? '') ? 'Values (one per line)' : 'Value'}
              {['in', 'not_in'].includes(value.operator ?? '') ? (
                <Textarea
                  aria-label={`${label} values`}
                  className="min-h-20 rounded-lg border border-input bg-background p-2"
                  value={(value.values ?? []).join('\n')}
                  onChange={(event) =>
                    onChange({ ...value, values: event.target.value.split('\n') })
                  }
                />
              ) : (
                <Input
                  aria-label={`${label} value`}
                  value={value.values?.[0] ?? ''}
                  onChange={(event) => onChange({ ...value, values: [event.target.value] })}
                />
              )}
            </Label>
          ) : null}
        </>
      )}
      {depth === 1 ? (
        <p className="text-xs text-muted-foreground">
          Strings are case-sensitive. Lists match any item; negative operators require no matching
          item. Globs support *, ? and [ranges]; * does not cross /. Missing enrichment stops
          evaluation.
        </p>
      ) : null}
    </fieldset>
  )
}
