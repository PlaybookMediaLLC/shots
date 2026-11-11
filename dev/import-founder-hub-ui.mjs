import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(process.argv[2] ?? '../shots-founder-hub')
const require = createRequire(path.join(source, 'apps/desktop/package.json'))
const { transformAsync } = require('@babel/core')
const lingui = (await import(require.resolve('@lingui/babel-plugin-lingui-macro'))).default
process.chdir(path.join(source, 'apps/desktop'))
const pages = 'clients/apps/web/components/settings/founder-hub'
const imports = {
  '@anlg/utils': '@/lib/utils',
  '@anlg/ui/components/icons': '@phosphor-icons/react',
  '@anlg/ui/components/ui/input-group': '@/components/settings/founder-hub/dictionary/input-group',
  '~/settings/queries': '@/components/settings/founder-hub/settings-context',
  '~/shared/config': '@/components/settings/founder-hub/settings-context',
  '~/auth/billing-context': '@/components/settings/founder-hub/billing-access',
  '@anlg/ui/components/ui/toast': 'sonner',
  '~/stt/keywords': '@/components/settings/founder-hub/general/keywords',
  '~/shared/theme/icon': '@/components/settings/founder-hub/appearance/icon',
  '~/shared/theme/resolve': '@/components/settings/founder-hub/appearance/resolve',
}
const files = new Map([
  ['apps/desktop/src/settings/shots-private-action.ts', `${pages}/private-action.ts`],
  ...['layout', 'preview-header'].map((name) => [`apps/desktop/src/shared/ui/resource-list/${name}.tsx`, `${pages}/resource-list/${name}.tsx`]),
  ...['template-body', 'template-sidebar', 'details', 'auto-form', 'auto-format-examples-dialog'].map((name) => [`apps/desktop/src/templates/${name}.tsx`, `${pages}/templates/${name}.tsx`]),
  ['apps/desktop/src/templates/utils.ts', `${pages}/templates/utils.ts`],
  ...['share-dialog', 'library'].map((name) => [`apps/desktop/src/resource-sharing/${name}.tsx`, `${pages}/resource-sharing/${name}.tsx`]),
  ...['template-icon', 'template-icon-picker', 'template-form', 'sections-editor'].map((name) => [`apps/desktop/src/templates/${name}.tsx`, `${pages}/templates/${name}.tsx`]),
  ['apps/desktop/src/templates/codec.ts', `${pages}/templates/codec.ts`],
  ['packages/ui/src/components/ui/input-group.tsx', `${pages}/dictionary/input-group.tsx`],
  ...[
    'setting-row',
    'page-title',
    'general/main-language',
    'general/spoken-languages',
    'general/timezone',
    'general/week-start',
    'general/audio-settings',
    'appearance/time-format',
    'appearance/sidebar-item-fields',
  ].map((name) => [`apps/desktop/src/settings/${name}.tsx`, `${pages}/${name}.tsx`]),
  ['apps/desktop/src/settings/general/language.ts', `${pages}/general/language.ts`],
  [
    'apps/desktop/src/settings/general/notification-app-options.ts',
    `${pages}/general/notification-app-options.ts`,
  ],
  ['apps/desktop/src/settings/schema.ts', `${pages}/schema.ts`],
  ['apps/desktop/src/shared/config/index.ts', `${pages}/config.ts`],
  ...[
    'appearance/index',
    'appearance/theme',
    'appearance/app-icon',
    'dictionary/index',
    'plan-gate',
  ].map((name) => [`apps/desktop/src/settings/${name}.tsx`, `${pages}/${name}.tsx`]),
  ['apps/desktop/src/stt/keywords.ts', `${pages}/general/keywords.ts`],
  ['apps/desktop/src/shared/theme/icon.ts', `${pages}/appearance/icon.ts`],
  ['apps/desktop/src/shared/theme/resolve.ts', `${pages}/appearance/resolve.ts`],
])
const manifest = {}
for (const [from, to] of files) {
  const original = await readFile(path.join(source, from), 'utf8')
  let code = original.replaceAll('Anarlog', 'Shots Founder Hub')
  if (from.startsWith('apps/desktop/src/resource-sharing/')) {
    code = code
      .replace('  requireResourceSharingContext,\n', '')
      .replace(/requireResourceSharingContext\(auth\),\s*/g, '')
      .replace('import { useOptionalAuth } from "~/auth";', 'import { useFounderHubUserId } from "../settings-context";')
      .replaceAll('const auth = useOptionalAuth()!;', 'const accountUserId = useFounderHubUserId();')
      .replaceAll('const auth = useOptionalAuth();', 'const accountUserId = useFounderHubUserId();')
      .replaceAll('if (!auth) return null;', 'if (!accountUserId) return null;')
      .replace('  const accountUserId = auth.session?.user.id;\n', '')
      .replace('open && owned?.shareId && auth.session && auth.supabase', 'open && owned?.shareId')
      .replace('Boolean(auth.session && !auth.session.user.is_anonymous)', 'Boolean(accountUserId)')
      .replace('() => void auth.signIn()', '() => router.push("/settings/founder-hub/account")')
      .replace('import { useTabs } from "~/store/zustand/tabs";', 'import { useRouter } from "@/i18n/navigation";')
      .replace('const openNew = useTabs((state) => state.openNew);', 'const router = useRouter();')
      .replaceAll('openNew({ type: "settings", state: { tab: "team" } });', 'router.push("/settings/founder-hub/teams");')
      .replace('import { useAvailableShareWorkspaces } from "~/session-sharing/source";', 'import { useAvailableShareWorkspaces } from "./hooks";')
      .replace('const workspaces = useAvailableShareWorkspaces(accountUserId);', 'const workspacesQuery = useAvailableShareWorkspaces(accountUserId);\n  const workspaces = workspacesQuery.data ?? [];')
      .replace('  GlassDialogCancelButton,\n  GlassDialogContent,', '  DialogContent as GlassDialogContent,')
      .replace('from "~/shared/ui/glass-dialog"', 'from "@/components/ui/dialog"')
      .replaceAll('<GlassDialogCancelButton', '<Button variant="outline"')
      .replaceAll('</GlassDialogCancelButton>', '</Button>')
      .replace('billing.isPaid', 'billing.isPro')
      .replaceAll('billing.isPaid', 'billing.isPro')
      .replace('billing.isReady && ', '')
    if (from.endsWith('share-dialog.tsx')) {
      code = code.replace('  const error =\n', '  const error =\n    workspacesQuery.error ??\n')
    }
    if (from.endsWith('library.tsx')) {
      code = code.replace('  if (available.length === 0) return null;', `  if (resources.isError) return <div role="alert" className="p-3 text-sm text-destructive">Shared library could not load. <Button variant="outline" onClick={() => void resources.refetch()}>Retry</Button></div>;
  if (available.length === 0) return null;`)
    }
  }
  if (from.startsWith('apps/desktop/src/templates/')) {
    code = code
      .replace('import type { TemplateSection } from "@anlg/store";', 'import type { TemplateSection } from "./queries";')
      .replaceAll('"~/resource-sharing"', '"./sharing"')
      .replaceAll('  AppFloatingPanel,\n', '')
      .replaceAll('  appFloatingMenuPanelClassName,\n', '')
      .replaceAll(' variant="app"', '')
      .replace(/<AppFloatingPanel[^>]*>/g, '')
      .replaceAll('</AppFloatingPanel>', '')
      .replaceAll('hover:text-black', 'hover:text-foreground')
      .replaceAll('text-red-600 focus:text-red-600', 'text-destructive focus:text-destructive')
      .replaceAll('"~/store/zustand/tabs"', '"./navigation"')
      .replaceAll('"~/shared/ui/resource-list"', '"../resource-list"')
  }
  if (from.endsWith('preview-header.tsx')) {
    code = code.replace('"~/templates/utils"', '"../templates/utils"')
      .replace('import type { ReactNode }', 'import type { ComponentProps, ReactNode }')
      .replace('Button, type ButtonProps', 'Button')
      .replace('ButtonProps["variant"]', 'ComponentProps<typeof Button>["variant"]')
  }
  if (from.endsWith('template-body.tsx')) {
    code = code.replace('import { setSettingValue }', 'import { useSetSettingValue }')
      .replace('  const handleDeleteTemplate =', '  const setDefaultTemplate = useSetSettingValue("selected_template_id");\n  const handleDeleteTemplate =')
      .replace('await setSettingValue("selected_template_id", id)', 'await setDefaultTemplate(id)')
      .replace('[cloneAsMine],\n  );\n\n  const handleDuplicateTemplate', '[cloneAsMine, setDefaultTemplate],\n  );\n\n  const handleDuplicateTemplate')
  }
  if (from.endsWith('templates/utils.ts')) {
    code = code.replace('useWebResources<Record<string, unknown>>("templates")', 'useWebResources("templates")')
  }
  if (from.endsWith('auto-form.tsx')) {
    code = code.replace('import { PromptEditor, type PromptEditorHandle } from "@anlg/editor/prompt";', 'import { Textarea } from "@/components/ui/textarea";')
      .replace('import { commands as templateCommands } from "@anlg/plugin-template";', 'import defaultFormat from "./default-format.json";')
      .replace('const AUTO_FORMAT_TOKENS = [] as const;', '')
      .replace('import { setSettingValue }', 'import { useSetSettingValues }')
      .replace('  const editorRef = useRef<PromptEditorHandle>(null);', '  const setValues = useSetSettingValues();\n  const [acknowledged, setAcknowledged] = useState(formatOverride);\n  const attempted = useRef<string | undefined>(undefined);')
      .replaceAll('      editorRef.current?.setValue(nextFormat);', '')
      .replaceAll('    editorRef.current?.setValue(defaultFormat);', '')
      .replaceAll('            editorRef.current?.setValue(format);', '')
      .replace('key={`${formatOverride}:${sourceQuery.data}`}', 'key={sourceQuery.data}')
      .replace('  const saveMutation = useMutation({', '  const [initialValue, setInitialValue] = useState(initialFormat);\n  const saveMutation = useMutation({')
      .replace('format: initialFormat', 'format: initialValue')
      .replace('form.reset({ format: nextFormat });', 'setInitialValue(nextFormat); form.reset({ format: nextFormat });')
      .replace('form.reset({ format: defaultFormat });', 'setInitialValue(defaultFormat); form.reset({ format: defaultFormat });')
    const renderStart = code.indexOf('      const rendered = await templateCommands.render(')
    const renderEnd = code.indexOf('      return stored;', renderStart)
    assert(renderStart >= 0 && renderEnd > renderStart)
    code = code.slice(0, renderStart) + `      if (stored.length > 16000) throw new Error("Summary format must be 16,000 characters or fewer.");
      if (formatOverride !== acknowledged && attempted.current !== formatOverride) throw new Error("The saved summary format changed elsewhere. Your draft has been kept.");
      attempted.current = stored;
      if (!(await setValues({auto_summary_prompt: stored}))) throw new Error("The summary format was not saved.");
      setAcknowledged(stored);
      attempted.current = undefined;
` + code.slice(renderEnd)
    code = code.replace('          <PlanGate plan="pro" allowed={billing.isPro}>', `          {formatOverride !== acknowledged && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive"><span>The saved summary format changed elsewhere. Your draft has been kept.</span><Button type="button" variant="outline" onClick={() => { setAcknowledged(formatOverride); attempted.current = undefined; setInitialValue(initialFormat); form.reset({format: initialFormat}); saveMutation.reset(); }}>Load saved format</Button></div>}
          <PlanGate plan="pro" allowed={billing.isPro}>`)
    code = code.replace('setSettingValue("selected_template_id", "")', 'setValues({selected_template_id: ""})')
      .replace('<PromptEditor\n                      ref={editorRef}', '<Textarea')
      .replace('ariaLabel=', 'aria-label=')
      .replace('initialValue={field.state.value}', 'value={field.state.value}')
      .replace('onChange={field.handleChange}', 'onChange={event => field.handleChange(event.target.value)}')
      .replace('                      tokens={AUTO_FORMAT_TOKENS}\n', '')
      .replace(/  const result = await templateCommands.getTemplateSource\("enhanceFormat"\);[\s\S]*?  return result.data;/, '  return defaultFormat;')
  }
  if (from.endsWith('auto-format-examples-dialog.tsx')) {
    code = code.replace('import { useLanguageModel } from "~/ai/hooks";', 'import { useSelectedDevice } from "../device-context";')
      .replace('  const model = useLanguageModel("enhance");', '  const device = useSelectedDevice();')
      .replace('if (!model)', 'if (!device?.report.autoFormatKey)')
      .replace('Choose an AI model before generating a format.', 'Connect a desktop with an AI model before generating a format.')
      .replace('inferSummaryFormat({ model, examples: populatedExamples })', 'inferSummaryFormat({ device: device!, examples: populatedExamples })')
      .replace('      if (!isTextExample(file)) {', '      if (file.size > MAX_FORMAT_EXAMPLE_LENGTH * 4) { toast.error(t`Each example must be 12,000 characters or fewer.`); continue; }\n      if (!isTextExample(file)) {')
      .replace('<label', '<Label').replace('</label>', '</Label>')
    code = 'import { Label } from "@/components/ui/label";\n' + code
  }
  if (from.endsWith('template-sidebar.tsx')) {
    code = code.replace('useCallback, useEffect, useMemo, useRef, useState', 'useCallback, useMemo, useRef, useState, type KeyboardEvent')
      .replace('import { useSquircleRef } from "@anlg/ui/hooks/use-squircle";', '')
      .replace('const searchRef = useSquircleRef<HTMLDivElement>();', 'const searchRef = useRef<HTMLDivElement>(null);')
      .replace('import { useNativeContextMenu } from "~/shared/hooks/useNativeContextMenu";', 'import { DotsThree } from "@phosphor-icons/react";\nimport { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";')
      .replace('import { CustomSidebarHeader } from "~/sidebar/custom-sidebar-header";', '')
      .replaceAll(' relative z-[60]', '')
      .replace('<CustomSidebarHeader>', '<div className="flex h-12 items-center justify-between"><span className="text-sm font-semibold">Templates</span><div className="flex items-center">')
      .replace('</CustomSidebarHeader>', '</div></div>')
      .replace('                  <ArrowsDownUp size={16} />', '                  <ArrowsDownUp aria-label="Sort templates" size={16} />')
      .replace('            onClick={createDefaultTemplate}', '            aria-label="Create template"\n            onClick={() => void createDefaultTemplate().catch(() => {})}')
      .replace('  useEffect(() => {\n    const handleKeyDown = (event: KeyboardEvent) => {', '  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {')
    const keyboardStart = code.indexOf('    window.addEventListener("keydown"')
    const keyboardEnd = code.indexOf('\n  return (\n    <div', keyboardStart)
    assert(keyboardStart >= 0 && keyboardEnd > keyboardStart)
    code = code.slice(0, keyboardStart).replace(/    };\n\n$/, '    };\n\n') + code.slice(keyboardEnd)
    code = code.replace('<div className="flex h-full w-full flex-col overflow-hidden">', '<div onKeyDownCapture={handleKeyDown} className="flex h-full w-full flex-col overflow-hidden">')
      .replaceAll('data-template-selected={item.selected}', 'ref={node => { if (item.selected) node?.scrollIntoView({block: "nearest"}); }} data-template-selected={item.selected}')
      .replace('data-template-selected={selected}', 'ref={node => { if (selected) node?.scrollIntoView({block: "nearest"}); }} data-template-selected={selected}')
    code = code.replace('  const showContextMenu = useNativeContextMenu(contextMenu);', '  const [menuOpen, setMenuOpen] = useState(false);')
      .replace('  return (\n    <button\n      onClick={() => onSelect(template.id)}', '  return (\n    <div className="relative group"><button\n      onClick={() => onSelect(template.id)}')
      .replace('        void showContextMenu(e);', '        e.preventDefault(); setMenuOpen(true);')
      .replace(/    <\/button>\n  \);\n}\s*$/, `    </button><DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="absolute right-0 top-1 h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={` + '`Actions for ${template.title || "Untitled"}`' + `}><DotsThree size={16}/></Button></DropdownMenuTrigger><DropdownMenuContent>{contextMenu.map((item, index) => "separator" in item ? <DropdownMenuSeparator key={index} /> : <DropdownMenuItem key={item.id} onSelect={() => { void Promise.resolve(item.action()).catch(() => {}); }}>{item.text}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>\n  );\n}\n`)
  }
  if (from.endsWith('sections-editor.tsx')) {
    code = code
      .replace('<Input\n          disabled={disabled}', '<Input\n          aria-label={`Section ${index + 1} title`}\n          disabled={disabled}')
      .replace('<textarea\n          disabled={disabled}', '<textarea\n          aria-label={`Section ${index + 1} instructions`}\n          disabled={disabled}')
      .replace('useCallback, useEffect, useRef, useState', 'useState')
      .replace('type SectionDraft =', 'type SectionDraft =')
    const start = code.indexOf('function useEditableSections(')
    const end = code.indexOf('export function SectionsList', start)
    assert(start >= 0 && end > start)
    code = code.slice(0, start) + `function useEditableSections({ disabled, initialItems, onChange }: {
      disabled: boolean; initialItems: TemplateSection[]; onChange: (items: TemplateSection[]) => void;
    }) {
      const [state, setState] = useState(() => ({ items: initialItems, drafts: initialItems.map(item => ({...item, key: crypto.randomUUID()})) }));
      if (state.items !== initialItems) {
        setState({items: initialItems, drafts: initialItems.map((item, index) => ({...item, key: state.drafts[index]?.key ?? crypto.randomUUID()}))});
      }
      const commit = (drafts: SectionDraft[]) => {
        const items = drafts.map(({title, description}) => ({title, description}));
        setState({items, drafts});
        onChange(items);
      };
      const insertSectionAt = (index: number) => {
        const next = [...state.drafts];
        next.splice(index, 0, {title: '', description: '', key: crypto.randomUUID()});
        commit(next);
      };
      return {
        drafts: state.drafts,
        addSection: () => insertSectionAt(state.drafts.length),
        changeSection: (draft: SectionDraft) => commit(state.drafts.map(item => item.key === draft.key ? draft : item)),
        deleteSection: (key: string) => commit(state.drafts.filter(item => item.key !== key)),
        insertSectionAt,
        moveSection: (key: string, direction: -1 | 1) => {
          const index = state.drafts.findIndex(item => item.key === key);
          const target = index + direction;
          if (index < 0 || target < 0 || target >= state.drafts.length) return;
          const next = [...state.drafts];
          next.splice(target, 0, next.splice(index, 1)[0]);
          commit(next);
        },
        reorderSections: (next: SectionDraft[]) => { if (!disabled) commit(next); },
      };
    }\n\n` + code.slice(end)
    code = code.replace('  const controls = useDragControls();\n', '')
      .replace('<Reorder.Item key={draft.key} value={draft}>', '<div key={draft.key}>')
      .replace('</Reorder.Item>', '</div>')
      .replace('                dragControls={controls}\n', '')
      .replace('  dragControls,\n', '')
      .replace('  dragControls: ReturnType<typeof useDragControls>;\n', '')
      .replace('  const [isFocused, setIsFocused] = useState(false);', '  const [isFocused, setIsFocused] = useState(false);\n  const dragControls = useDragControls();')
      .replace('<div className="group bg-card relative">', '<Reorder.Item value={item} dragControls={dragControls} dragListener={false} className="group bg-card relative">')
      .replace(/    <\/div>\n  \);\n}\s*$/, '    </Reorder.Item>\n  );\n}')
      .replace('          type="button"\n          className="absolute', '          type="button"\n          aria-label="Move section"\n          className="absolute')
  }
  if (from.endsWith('template-form.tsx')) {
    code = code.replace('  const { id } = template;', '  const { id } = template;\n  const draft = useTemplateInitialValue(template);\n  const [initialTemplate] = useState(draft);')
      .replace('  useSaveTemplate,', '  useSaveTemplate,\n  useTemplateInitialValue,')
      .replace('const saveTemplate = useSaveTemplate();', 'const saveTemplate = useSaveTemplate(initialTemplate);')
      .replace('        ...template,\n        ...value,', '        ...initialTemplate,\n        ...value,')
      .replace('void formApi.handleSubmit();', 'void saveTemplate({...initialTemplate, ...formApi.state.values}).catch(() => {});')
      .replace('title: template.title ?? "",', 'title: initialTemplate.title ?? "",')
      .replace('description: template.description ?? "",', 'description: initialTemplate.description ?? "",')
      .replace('icon: template.icon,', 'icon: initialTemplate.icon,')
      .replace('targets: template.targets ?? [],', 'targets: initialTemplate.targets ?? [],')
      .replace('sections: template.sections ?? [],', 'sections: initialTemplate.sections ?? [],')
      .replace('                  placeholder={t`Enter template title`}', '                  aria-label={t`Template title`}\n                  placeholder={t`Enter template title`}')
      .replace('                  placeholder={t`Describe the template purpose...`}', '                  aria-label={t`Template description`}\n                  placeholder={t`Describe the template purpose...`}')
  }
  if (from.endsWith('template-icon-picker.tsx')) {
    code = code
      .replace('import { HexColorInput, HexColorPicker } from "react-colorful";', 'import { ColorPanel } from "@/components/ui/color-picker";')
      .replace('anarlog.template-picker.recent-emojis', 'shots.founder-hub.template-picker.recent-emojis')
      .replace(/\s*<div className="mb-2 flex items-center gap-2">[\s\S]*?<HexColorPicker[\s\S]*?\/>/, '<ColorPanel color={iconColor} onChange={selectColor} alpha={false} />')
  }
  if (from.endsWith('notification-app-options.ts'))
    code = code.replace(
      'import type { InstalledApp } from "@anlg/plugin-detect";',
      'type InstalledApp = { id: string; name: string };'
    )
  if (from.endsWith('appearance/theme.tsx'))
    code = code
      .replace(/import \{ applyThemePreference \}[^;]+;\n/, '')
      .replace(/  const appIcon = .*;\n/, '')
      .replace(/import \{ normalizeAppIconPreference \}[^;]+;\n/, '')
      .replace(/\s*void applyThemePreference\(option.value, appIcon\);/, '')
  if (from.endsWith('appearance/app-icon.tsx')) {
    code = code
      .replace(/import \{ useQuery \}[^;]+;\n/, '')
      .replace(/import \{ getIdentifier \}[^;]+;\n/, '')
      .replace(/import \{ platform \}[^;]+;\n/, '')
      .replace(/import \{ applyAppIconPreference \}[^;]+;\n/, '')
      .replace(
        /  const \{ data: appIdentifier[\s\S]*?\n  \}\);/,
        '  const device = useSelectedDevice();\n  const appIdentifier = device?.report.identifier ?? "com.hyprnote.stable";'
      )
      .replace('platform() !== "macos"', 'device?.report.platform !== "macos"')
      .replace(/\s*void applyAppIconPreference\(option, theme\);/, '')
      .replaceAll('/assets/app-icons/', '/founder-hub/app-icons/')
      .replaceAll('src={`', 'src={publicImageUrl(`')
      .replaceAll('srcSet={`', 'srcSet={publicImageUrl(`')
      .replaceAll('.png`}', '.png`)}')
    code =
      `import { publicImageUrl } from '@/lib/assets/public-image';\n` +
      `import { useSelectedDevice } from '@/components/settings/founder-hub/device-context';\n` +
      code
  }
  if (from.endsWith('dictionary/index.tsx'))
    code = code
      .replace(/import \{ trackAnalyticsEvent \}[^;]+;\n/, '')
      .replace(/\s*trackAnalyticsEvent\("dictionary_updated", \{[\s\S]*?\}\);/g, '')
      .replace('onSave: (value: string) => void;', 'onSave: (value: string) => Promise<boolean>;')
      .replace('onSubmit: ({ value }) => {', 'onSubmit: async ({ value }) => {')
      .replace(
        'onSave(JSON.stringify(nextTerms));\n      form.setFieldValue',
        'if (!(await onSave(JSON.stringify(nextTerms)))) return;\n      form.setFieldValue'
      )
      .replaceAll(
        '    onSave(JSON.stringify(nextTerms));',
        '    return onSave(JSON.stringify(nextTerms));'
      )
      .replace(
        'onEdit: (term: string, nextTerm: string) => void;',
        'onEdit: (term: string, nextTerm: string) => Promise<boolean>;'
      )
      .replace('const saveEdit = () => {', 'const saveEdit = async () => {')
      .replace(
        '    onEdit(term, nextTerm);\n    setEditValue(null);',
        '    if (await onEdit(term, nextTerm)) setEditValue(null);'
      )
  for (const [oldName, newName] of Object.entries(imports))
    code = code.replaceAll(`"${oldName}"`, `"${newName}"`)
  code = code
    .replaceAll('@anlg/ui/components/ui/', '@/components/ui/')
    .replaceAll('~/settings/', '@/components/settings/founder-hub/')
  if (from.endsWith('input-group.tsx'))
    code = code
      .replaceAll('"./button"', '"@/components/ui/button"')
      .replaceAll('"./input"', '"@/components/ui/input"')
      .replaceAll('"./textarea"', '"@/components/ui/textarea"')
      .replace(/import \{ Textarea \} from [^;]+;\n/, '')
      .replace(/function InputGroupText\([\s\S]*?\n}\n/, '')
      .replace(/function InputGroupTextarea\([\s\S]*?\n}\n/, '')
      .replace(/  InputGroupText,\n|  InputGroupTextarea,\n/g, '')
  if (from.endsWith('page-title.tsx'))
    code = code.replace(
      'font-hand text-3xl leading-tight font-semibold tracking-normal',
      'text-2xl font-semibold tracking-tight text-foreground'
    )
  if (code.includes('<input') || code.includes('<button') || code.includes('<textarea')) {
    if (!from.startsWith('packages/ui/')) {
      const declarations = [
        code.includes('<input') &&
          `import { Input as UnstyledInput } from '@/components/ui/input';`,
        code.includes('<button') &&
          `import { Button as UnstyledButton } from '@/components/ui/button';`,
        code.includes('<textarea') &&
          `import { Textarea as UnstyledTextarea } from '@/components/ui/textarea';`,
      ].filter(Boolean)
      code =
        declarations.join('\n') +
        '\n' +
        code
          .replaceAll('<input', '<UnstyledInput')
          .replaceAll('<textarea', '<UnstyledTextarea')
          .replaceAll('</textarea>', '</UnstyledTextarea>')
          .replaceAll('<button', '<UnstyledButton variant="custom" size={null}')
          .replaceAll('</button>', '</UnstyledButton>')
    }
  }
  if (from.endsWith('week-start.tsx')) {
    code = code
      .replace('function getSystemWeekStart()', 'function getSystemWeekStart(locale: string)')
      .replace('  const locale = navigator.language || "en-US";\n', '')
      .replace('  } catch {}', '  } catch { return "sunday"; }')
      .replace(
        'const systemDefault = useMemo(() => getSystemWeekStart(), []);',
        'const device = useSelectedDevice();\n  const systemDefault = useMemo(() => getSystemWeekStart(device?.report.locale || "en-US"), [device?.report.locale]);'
      )
      .replaceAll(
        '(options as any)',
        '(options as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } })'
      )
    code =
      `import { useSelectedDevice } from '@/components/settings/founder-hub/device-context';\n` +
      code
  }
  if (from.endsWith('timezone.tsx')) {
    code = code.replace(
      /  const systemTimezone = useMemo\([\s\S]*?\n  \}, \[\]\);/,
      '  const device = useSelectedDevice();\n  const systemTimezone = device?.report.timezone || "UTC";'
    )
    code =
      `import { useSelectedDevice } from '@/components/settings/founder-hub/device-context';\n` +
      code
  }
  // Keep the original message IDs and JSX; Next does not run the desktop's Vite macro pipeline.
  if (code.includes('@lingui/')) {
    const result = await transformAsync(code, {
      filename: from,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ['typescript', 'jsx'] },
      plugins: [lingui],
    })
    code = result.code
  }
  const destination = path.join(root, to)
  assert(
    !/from ["'](?:@anlg\/|@tauri-apps\/|~\/|@lingui\/react\/macro)/.test(code),
    `${from} still imports a desktop runtime; add its Shots adapter before importing it.`
  )
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(
    destination,
    `// Ported from ${from}; see dev/import-founder-hub-ui.mjs.\n${code}\n`
  )
  manifest[from] = { target: to, sha256: createHash('sha256').update(original).digest('hex') }
}
await writeFile(path.join(root, pages, 'source.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(path.join(root, pages, 'LICENSE'), await readFile(path.join(source, 'LICENSE')))
await writeFile(path.join(root, pages, 'templates/default-format.json'), JSON.stringify(await readFile(path.join(source, 'crates/template-app/assets/enhance.format.md.jinja'), 'utf8')) + '\n')
const catalogSource = 'apps/web/.content-collections/generated/allTemplates.js'
const catalogText = await readFile(path.join(source, catalogSource), 'utf8')
assert(catalogText.trim().startsWith('export default '), 'Unrecognized public template catalog')
const catalog = JSON.parse(catalogText.trim().slice('export default '.length).replace(/;$/, ''))
assert(Array.isArray(catalog))
await writeFile(path.join(root, pages, 'templates/catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
await cp(
  path.join(source, 'apps/desktop/public/assets/app-icons'),
  path.join(root, 'clients/apps/web/public/founder-hub/app-icons'),
  { recursive: true }
)
console.log(`Imported ${files.size} Founder Hub UI files.`)
