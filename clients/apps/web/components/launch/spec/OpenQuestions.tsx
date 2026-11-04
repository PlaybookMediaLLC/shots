'use client'

import { useUnsavedCampaignChanges } from '@/components/campaigns/useUnsavedCampaignChanges'
import { useState } from 'react'
import { Group, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { type ReleaseSpecContent, SPEC_SECTION_LABELS } from '@/lib/launch/spec-schema'
import { Textarea } from '@/components/ui/textarea'

type Question = ReleaseSpecContent['openQuestions'][number]

/**
 * Gaps the draft would otherwise have invented. Answers are saved as a new
 * version and feed the next draft as part of the brief.
 */
export function OpenQuestions({
  editable,
  onSave,
  questions,
}: {
  editable: boolean
  onSave: (questions: Question[]) => Promise<void>
  questions: Question[]
}) {
  const [answers, setAnswers] = useState(() => questions.map((question) => question.answer))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = answers.some((answer, position) => answer.trim() !== questions[position]?.answer)

  useUnsavedCampaignChanges(changed && !saving)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      // On success the page refreshes with the new version.
      await onSave(
        questions.map((question, position) => ({
          ...question,
          answer: answers[position]?.trim() ?? '',
        }))
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The answers could not be saved.')
      setSaving(false)
    }
  }

  return (
    <Section
      description="What the sources did not say. Your answers feed the next draft: save them, then redraft to use them."
      id="spec-openQuestions"
      title="Open questions"
    >
      <Group>
        {questions.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No open questions.</p>
        ) : (
          questions.map((question, position) => (
            <div className="flex flex-col gap-2 px-5 py-4" key={position}>
              <div className="flex items-start justify-between gap-4">
                <h3 className="text-ui-lg font-medium text-foreground">{question.question}</h3>
                <a
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                  href={`#spec-${question.section}`}
                >
                  {SPEC_SECTION_LABELS[question.section]}
                </a>
              </div>
              {question.reason ? (
                <p className="text-xs leading-5 text-muted-foreground">{question.reason}</p>
              ) : null}
              {editable ? (
                <Textarea
                  aria-label={`Answer: ${question.question}`}
                  className="mt-1 min-h-10 w-full rounded-lg bg-foreground/[0.03] px-3 py-2 text-sm text-foreground ring-1 ring-foreground/[0.08] outline-none [field-sizing:content] placeholder:text-muted-foreground/75 focus:ring-foreground/25"
                  maxLength={1_000}
                  onChange={(event) =>
                    setAnswers(
                      answers.map((answer, index) =>
                        index === position ? event.target.value : answer
                      )
                    )
                  }
                  placeholder="Your answer"
                  rows={1}
                  value={answers[position] ?? ''}
                />
              ) : question.answer ? (
                <p className="text-sm text-foreground/80">{question.answer}</p>
              ) : (
                <p className="text-xs text-muted-foreground/75">Not answered.</p>
              )}
            </div>
          ))
        )}
        {editable && questions.length > 0 ? (
          <div className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <p className="text-xs text-muted-foreground">
              Saving creates a new version. Redraft to use your answers.
            </p>
            <Button
              className="shrink-0 rounded-lg"
              disabled={!changed || saving}
              onClick={() => void save()}
              size="sm"
              type="button"
            >
              {saving ? 'Saving…' : 'Save answers'}
            </Button>
          </div>
        ) : null}
      </Group>
      {error ? (
        <p
          className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </Section>
  )
}
