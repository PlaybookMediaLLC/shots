'use strict'

const vscode = require('vscode')
const { codeProjectRequest, createCodeProject } = require('./lib/request')

const KEY = 'shots.apiKey'

/** Ask for a workspace API key and keep it in the editor's secret storage. */
async function askForKey(context) {
  const key = await vscode.window.showInputBox({
    title: 'Shots API key',
    prompt: 'A workspace API key with the asset:write scope (Workspace settings › API keys).',
    password: true,
    ignoreFocusOut: true,
  })
  if (key?.trim()) await context.secrets.store(KEY, key.trim())
  return key?.trim()
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('shots.setApiKey', () => askForKey(context)),
    vscode.commands.registerCommand('shots.sendSelection', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return vscode.window.showWarningMessage('Open a file to send code to Shots.')
      const selection = editor.selection
      const whole = selection.isEmpty
      const range = whole ? new vscode.Range(0, 0, editor.document.lineCount, 0) : selection
      const settings = vscode.workspace.getConfiguration('shots')
      try {
        const body = codeProjectRequest({
          fileName: editor.document.fileName,
          languageId: editor.document.languageId,
          text: editor.document.getText(range),
          startLine: whole ? 1 : selection.start.line + 1,
          endLine: whole ? editor.document.lineCount : selection.end.line + 1,
          theme: settings.get('theme') || undefined,
        })
        const key = (await context.secrets.get(KEY)) ?? (await askForKey(context))
        if (!key) return
        const project = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Sending to Shots…' },
          () => createCodeProject(settings.get('origin'), key, body)
        )
        await vscode.env.openExternal(vscode.Uri.parse(project.url))
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
      }
    })
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
