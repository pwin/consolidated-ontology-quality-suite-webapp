import * as vscode from 'vscode';

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

export function htmlShell(webview: vscode.Webview, title: string, bodyHtml: string, scriptBody: string): string {
  const n = nonce();
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${n}';">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px; }
  h1, h2, h3 { font-weight: 600; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.9em; }
  code, pre { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); }
  pre { padding: 8px; overflow: auto; white-space: pre-wrap; }
  textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); font-family: var(--vscode-editor-font-family); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.8em; margin-right: 4px; }
  .Violation { background: var(--vscode-testing-iconFailed, #f14c4c); color: white; }
  .Warning { background: var(--vscode-testing-iconQueued, #cca700); color: black; }
  .Info { background: var(--vscode-charts-blue, #3794ff); color: white; }
  .Hint { background: var(--vscode-descriptionForeground, #888); color: white; }
  .panel { display: flex; flex-direction: column; gap: 8px; }
  .svg-container { border: 1px solid var(--vscode-panel-border); overflow: auto; max-height: 70vh; }
  .svg-container svg { max-width: none; }
</style>
</head>
<body>
${bodyHtml}
<script nonce="${n}">
${scriptBody}
</script>
</body>
</html>`;
}
