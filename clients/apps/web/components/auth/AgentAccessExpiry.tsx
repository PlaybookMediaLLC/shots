'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function AgentAccessExpiry() {
  const [expiry, setExpiry] = useState('never')

  return (
    <>
      <Input name="expiresInDays" type="hidden" value={expiry === 'never' ? '' : expiry} />
      <Select onValueChange={setExpiry} value={expiry}>
        <SelectTrigger
          aria-label="Access expires"
          className="h-10 w-full rounded-lg bg-black/30 px-3 text-white ring-1 ring-white/[0.08]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="never">Never (revoke it in Settings → Agents &amp; API keys)</SelectItem>
          <SelectItem value="30">In 30 days</SelectItem>
          <SelectItem value="90">In 90 days</SelectItem>
          <SelectItem value="365">In a year</SelectItem>
        </SelectContent>
      </Select>
    </>
  )
}
