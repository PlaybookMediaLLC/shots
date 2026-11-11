// Ported from apps/desktop/src/templates/auto-format-examples-dialog.tsx; see dev/import-founder-hub-ui.mjs.
import { Input as UnstyledInput } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { CircleNotch, FileText, Plus, Trash, UploadSimple } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import {
  inferSummaryFormat,
  MAX_FORMAT_EXAMPLE_LENGTH,
  MAX_FORMAT_EXAMPLES,
} from './auto-format-inference'
import { useFounderHubUserId, useSelectedDevice } from '../device-context'
export function AutoFormatExamplesDialog({
  onClose,
  onGenerated,
}: {
  onClose: () => void
  onGenerated: (format: string) => void
}) {
  const { _: _t } = _useLingui()
  const device = useSelectedDevice()
  const userId = useFounderHubUserId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [examples, setExamples] = useState([''])
  const populatedExamples = examples.map((example) => example.trim()).filter(Boolean)
  const inferenceMutation = useMutation({
    mutationFn: async () => {
      if (!device?.report.autoFormatKey) {
        throw new Error(
          _t(
            /*i18n*/
            {
              id: '5TtHva',
              message: 'Connect a desktop with an AI model before generating a format.',
            }
          )
        )
      }
      if (populatedExamples.length === 0) {
        throw new Error(
          _t(
            /*i18n*/
            {
              id: 'mZXBoQ',
              message: 'Add at least one example summary.',
            }
          )
        )
      }
      return inferSummaryFormat({
        device: device!,
        userId,
        examples: populatedExamples,
      })
    },
    onSuccess: (format) => {
      onGenerated(format)
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })
  const updateExample = (index: number, value: string) => {
    setExamples((current) =>
      current.map((example, currentIndex) => (currentIndex === index ? value : example))
    )
  }
  const removeExample = (index: number) => {
    setExamples((current) => {
      const remaining = current.filter((_, currentIndex) => currentIndex !== index)
      return remaining.length > 0 ? remaining : ['']
    })
  }
  const uploadExamples = async (files: FileList | null) => {
    const currentCount = populatedExamples.length
    const availableSlots = MAX_FORMAT_EXAMPLES - currentCount
    const selectedFiles = Array.from(files ?? [])
    if (selectedFiles.length > availableSlots) {
      toast.error(
        _t(
          /*i18n*/
          {
            id: 'UYcdFk',
            message: 'You can use up to three example summaries.',
          }
        )
      )
    }
    const loadedExamples: string[] = []
    for (const file of selectedFiles.slice(0, availableSlots)) {
      if (file.size > MAX_FORMAT_EXAMPLE_LENGTH * 4) {
        toast.error(
          _t(
            /*i18n*/
            {
              id: 'oaknHa',
              message: 'Each example must be 12,000 characters or fewer.',
            }
          )
        )
        continue
      }
      if (!isTextExample(file)) {
        toast.error(
          _t(
            /*i18n*/
            {
              id: 'yttrRn',
              message: 'Examples must be Markdown or plain text files.',
            }
          )
        )
        continue
      }
      const content = (await file.text()).replace(/\r\n/g, '\n').trim()
      if (content.length > MAX_FORMAT_EXAMPLE_LENGTH) {
        toast.error(
          _t(
            /*i18n*/
            {
              id: 'oaknHa',
              message: 'Each example must be 12,000 characters or fewer.',
            }
          )
        )
        continue
      }
      if (content) loadedExamples.push(content)
    }
    if (loadedExamples.length > 0) {
      setExamples((current) => {
        const populated = current.filter((example) => example.trim())
        return [...populated, ...loadedExamples].slice(0, MAX_FORMAT_EXAMPLES)
      })
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !inferenceMutation.isPending) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-border border-b px-6 py-5 pr-12">
          <DialogTitle>
            <_Trans
              {
                /*i18n*/
                ...{
                  id: 'VQG_Gi',
                  message: 'Improve summary format',
                }
              }
            />
          </DialogTitle>
          <DialogDescription>
            <_Trans
              {
                /*i18n*/
                ...{
                  id: '5VmHmw',
                  message:
                    'Attach up to three past summaries you like. Shots Founder Hub will learn how you prefer meeting notes to be structured and written.',
                }
              }
            />
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-6 py-5">
          <div className="bg-muted/50 text-muted-foreground flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs">
            <FileText className="mt-0.5 size-4 shrink-0" />
            <_Trans
              {
                /*i18n*/
                ...{
                  id: 'GKxRQX',
                  message:
                    'Examples are used only to improve this format. They are not saved or reused for future meetings.',
                }
              }
            />
          </div>

          {examples.map((example, index) => (
            <div key={index} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`auto-format-example-${index}`} className="text-sm font-medium">
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: 'pe3MoC',
                        message: 'Example summary',
                      }
                    }
                  />{' '}
                  {index + 1}
                </Label>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-muted-foreground size-7"
                  aria-label={_t(
                    /*i18n*/
                    {
                      id: '2XTNBb',
                      message: 'Remove example {0}',
                      values: {
                        0: index + 1,
                      },
                    }
                  )}
                  onClick={() => removeExample(index)}
                  disabled={inferenceMutation.isPending}
                >
                  <Trash className="size-4" />
                </Button>
              </div>
              <Textarea
                id={`auto-format-example-${index}`}
                value={example}
                maxLength={MAX_FORMAT_EXAMPLE_LENGTH}
                onChange={(event) => updateExample(index, event.target.value)}
                placeholder={_t(
                  /*i18n*/
                  {
                    id: 'J0Ilc2',
                    message: 'Paste a past summary you like...',
                  }
                )}
                className="min-h-36 resize-y font-mono text-sm leading-5"
                disabled={inferenceMutation.isPending}
              />
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setExamples((current) => [...current, ''])}
              disabled={examples.length >= MAX_FORMAT_EXAMPLES || inferenceMutation.isPending}
            >
              <Plus className="size-4" />
              <_Trans
                {
                  /*i18n*/
                  ...{
                    id: '1x4W9u',
                    message: 'Add example',
                  }
                }
              />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={
                populatedExamples.length >= MAX_FORMAT_EXAMPLES || inferenceMutation.isPending
              }
            >
              <UploadSimple className="size-4" />
              <_Trans
                {
                  /*i18n*/
                  ...{
                    id: 'dnKgPP',
                    message: 'Attach Markdown or text',
                  }
                }
              />
            </Button>
            <span className="text-muted-foreground ml-auto text-xs">
              {populatedExamples.length} / {MAX_FORMAT_EXAMPLES}
            </span>
            <UnstyledInput
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              multiple
              className="hidden"
              onChange={(event) => {
                void uploadExamples(event.currentTarget.files).catch((error) =>
                  toast.error(error.message)
                )
                event.currentTarget.value = ''
              }}
            />
          </div>
        </div>

        <DialogFooter className="border-border border-t px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={inferenceMutation.isPending}
          >
            <_Trans
              {
                /*i18n*/
                ...{
                  id: 'dEgA5A',
                  message: 'Cancel',
                }
              }
            />
          </Button>
          <Button
            type="button"
            onClick={() => inferenceMutation.mutate()}
            disabled={populatedExamples.length === 0 || inferenceMutation.isPending}
          >
            {inferenceMutation.isPending ? <CircleNotch className="size-4 animate-spin" /> : null}
            <_Trans
              {
                /*i18n*/
                ...{
                  id: 'jdbCnX',
                  message: 'Improve format',
                }
              }
            />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
function isTextExample(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase()
  return (
    file.type === 'text/plain' ||
    file.type === 'text/markdown' ||
    extension === 'txt' ||
    extension === 'md' ||
    extension === 'markdown'
  )
}
