import * as vscode from 'vscode';
import * as mime from 'mime-types';
import { providerStore, treeViewStore } from '../stores';
import {
  downloadToTmpFile,
  getFilePath,
  readFile,
  unzipToTmpDir,
  contains,
  postToPanel
} from '../utils';
import { FunctionsAPI } from './api';
import { CloudFunctionItem, FunctionsProvider } from './FunctionsProvider';
import { getDetailsFromName } from './utils';

let context: vscode.ExtensionContext;
const panelViews: {
  [k: string]: {
    panel: vscode.WebviewPanel;
    isLive: boolean;
    isReady: boolean;
  };
} = {};

export function registerFunctionsCommands(_context: vscode.ExtensionContext) {
  context = _context;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'firebaseExplorer.functions.refresh',
      refreshFunctions
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'firebaseExplorer.functions.triggerHTTPS',
      triggerHTTPSFunction
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'firebaseExplorer.functions.copyTrigger',
      copyTrigger
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'firebaseExplorer.functions.openInConsole.cloud',
      openInCloudConsole
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'firebaseExplorer.functions.openInConsole.firebase',
      openInFirebaseConsole
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'firebaseExplorer.functions.viewLogs',
      viewLogs
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'firebaseExplorer.functions.viewSource',
      viewSource
    )
  );
}

function refreshFunctions(): void {
  const functionsProvider = providerStore.get<FunctionsProvider>('functions');
  functionsProvider.refresh();
}

async function triggerHTTPSFunction(element: CloudFunctionItem) {
  if (!element) {
    return;
  }

  if (!element.cloudFunction.httpsTrigger) {
    throw new Error('Function is not HTTPS-triggered.');
  }

  const fn = element.cloudFunction;
  const api = FunctionsAPI.for(element.account, element.project);

  const methodOptions: vscode.QuickPickItem[] = [
    {
      label: 'GET',
      description: 'Do a GET request'
    },
    {
      label: 'POST',
      description: 'Do a POST request'
    }
  ];

  const methodPick = await vscode.window.showQuickPick(methodOptions, {
    ignoreFocusOut: true
  });

  if (!methodPick) {
    return;
  }

  await vscode.window.withProgress(
    {
      title: 'Triggering HTTPS Cloud Function: ' + fn.displayName,
      location: vscode.ProgressLocation.Notification
    },
    async () => {
      const response = await api.triggerHTTPS(fn, methodPick.label);

      vscode.window
        .showInformationMessage(
          `Function triggered. Response status code: ${response.statusCode}`,
          'See response body'
        )
        .then(async action => {
          if (action === 'See response body') {
            const contentType: string =
              response.headers['content-type'] || 'text/plain';

            const textDocument = await vscode.workspace.openTextDocument({
              language: mime.extension(contentType) || undefined,
              content: response.body
            });

            vscode.window.showTextDocument(textDocument);
          }
        });
    }
  );
}

function copyTrigger(element: CloudFunctionItem) {
  if (!element) {
    return;
  }

  if (!element.cloudFunction.httpsTrigger) {
    throw new Error('Function is not HTTPS-triggered.');
  }

  vscode.env.clipboard.writeText(element.cloudFunction.httpsTrigger.url);
}

function openInCloudConsole(element: CloudFunctionItem): void {
  if (!element) {
    return;
  }

  const details = getDetailsFromName(element.cloudFunction.name);
  vscode.commands.executeCommand(
    'vscode.open',
    vscode.Uri.parse(
      `https://console.cloud.google.com/functions/details/${details.location}/${
        details.name
      }?project=${details.projectId}`
    )
  );
}

function openInFirebaseConsole(element: CloudFunctionItem): void {
  if (!element) {
    return;
  }

  const details = getDetailsFromName(element.cloudFunction.name);
  vscode.commands.executeCommand(
    'vscode.open',
    vscode.Uri.parse(
      `https://console.firebase.google.com/project/${
        details.projectId
      }/functions/logs?functionFilter=${details.name}`
    )
  );
}

async function viewLogs(element: CloudFunctionItem): Promise<void> {
  if (!element) {
    return;
  }

  const panelId =
    element.account.user.email + '--' + element.cloudFunction.name;

  try {
    if (contains(panelViews, panelId)) {
      const { panel, isLive, isReady } = panelViews[panelId];
      if (isReady && !isLive) {
        setImmediate(() => {
          postToPanel(panel, {
            command: 'fetchNew'
          });
        });
      }
      panel.reveal();
    } else {
      const fnName = element.cloudFunction.displayName;
      await vscode.window.withProgress(
        {
          title: 'Getting Cloud Functions log for ' + fnName,
          location: vscode.ProgressLocation.Notification
        },
        async () => {
          const api = FunctionsAPI.for(element.account, element.project);
          let logEntries = await api.getLog(element.cloudFunction);

          const panel = vscode.window.createWebviewPanel(
            'function.logTail',
            'Log: ' + fnName,
            vscode.ViewColumn.One,
            {
              enableScripts: true,
              retainContextWhenHidden: true
            }
          );

          panel.webview.html = await readFile(
            getFilePath('ui', 'functions', 'log.html'),
            'utf8'
          );

          panel.webview.onDidReceiveMessage(async data => {
            switch (data.command) {
              case 'ready':
                panelViews[panelId] = {
                  ...panelViews[panelId],
                  isReady: true
                };
                postToPanel(panel, {
                  command: 'initialize',
                  name: fnName,
                  isLive: false,
                  entries: logEntries
                });
                // logEntries = undefined as any;
                break;
              case 'isLive':
                panelViews[panelId] = {
                  ...panelViews[panelId],
                  isLive: data.isLive
                };
                break;
              case 'getEntries':
                const entries = await api.getLog(element.cloudFunction, {
                  since: data.since
                });
                postToPanel(panel, {
                  command: 'addEntries',
                  entries
                });
                break;
            }
          });

          // panel.onDidChangeViewState(
          //   _event => {
          //     const panel = _event.webviewPanel;
          //   },
          //   null,
          //   context.subscriptions
          // );

          panel.onDidDispose(
            () => {
              delete panelViews[panelId];
            },
            null,
            context.subscriptions
          );

          panelViews[panelId] = { panel, isLive: false, isReady: false };
        }
      );
    }
  } catch (err) {
    console.log({ err });
  }
}

async function viewSource(element: CloudFunctionItem): Promise<void> {
  if (!element) {
    return;
  }

  const fnName = element.cloudFunction.displayName;

  try {
    await vscode.window.withProgress(
      {
        title: 'Getting source from Cloud Storage for ' + fnName,
        location: vscode.ProgressLocation.Notification
      },
      async () => {
        const api = FunctionsAPI.for(element.account, element.project);
        const downloadUrl = await api.getDownloadUrl(element.cloudFunction);
        const tmpZipFile = await downloadToTmpFile(downloadUrl);
        try {
          const tmpDir = await unzipToTmpDir(tmpZipFile.path);
          tmpZipFile.cleanup();
          element.setSourceDir(tmpDir.path);

          const provider = providerStore.get<FunctionsProvider>('functions');
          const treeView = treeViewStore.get('functions');

          provider.refresh(element);
          treeView.reveal(element, { expand: true });
        } catch (err) {
          tmpZipFile.cleanup();
          throw err;
        }
      }
    );
  } catch (err) {
    console.log({ err });
  }
}
