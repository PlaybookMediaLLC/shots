import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { pilotEventSchema } from '../lib/pilot/schema'
import { reportPilotLedger } from '../lib/pilot/report'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      schema: { type: 'boolean' },
      template: { type: 'boolean' },
      input: { type: 'string' },
      'metric-version': { type: 'string' },
      'cohort-month': { type: 'string' },
      'as-of': { type: 'string' },
      'followup-days': { type: 'string' },
    },
  })
  if (values.schema) {
    process.stdout.write(
      `${JSON.stringify({ ...z.toJSONSchema(pilotEventSchema), $id: 'urn:shots:pilot-event:1' }, null, 2)}\n`
    )
    return
  }
  if (values.template) return // A blank JSONL ledger contains zero records, never fabricated outcomes.
  if (
    !values.input ||
    values['metric-version'] !== '1' ||
    !values['cohort-month'] ||
    !values['as-of'] ||
    !values['followup-days']?.match(/^[1-9][0-9]*$/)
  )
    throw new Error(
      'Required: --input FILE --metric-version 1 --cohort-month YYYY-MM --as-of UTC --followup-days N'
    )
  const input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    await readFile(values.input)
  )
  const report = reportPilotLedger(input, {
    metricVersion: '1',
    cohortMonth: values['cohort-month'],
    asOf: values['as-of'],
    followupDays: Number(values['followup-days']),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error: unknown) => {
  // Filesystem errors can contain private paths; only validation errors are safe to report.
  process.stderr.write(
    `${error instanceof Error && !('code' in error) ? error.message : 'Could not read the private ledger'}\n`
  )
  process.exitCode = 1
})
