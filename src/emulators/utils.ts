import { dirname } from 'path';
import * as vscode from 'vscode';
import * as linkify from 'linkify-urls';
import { spawn, ChildProcess } from 'child_process';
import { WebSocketServer } from './server';
import { ProjectManager, FirebaseProject } from '../projects/ProjectManager';
import { AccountManager, AccountInfo } from '../accounts/AccountManager';
import {
  webviewPanels,
  postToPanel,
  ansiToHTML,
  readFile,
  contains
} from '../utils';
import { findPidByPort } from './find-process';
import { getCliConfig } from '../accounts/cli';

const psNode = require('ps-node');

const EMULATORS_START_COMMAND = 'emulators:start';

let cliProcess: ChildProcess | undefined;

export interface PsNodeResult {
  pid: string;
  ppid: string;
  command: string;
  arguments: string[];
}

export async function startEmulators(
  server: WebSocketServer,
  workspacePath: string,
  email: string,
  projectId: string,
  emulators: 'all' | string[],
  debug: boolean
): Promise<void> {
  server.useProjectManager(ProjectManager.for(email, projectId));
  await server.start();

  return new Promise(async resolve => {
    try {
      let args = [EMULATORS_START_COMMAND, '--ws', server.getAddress()];

      if (Array.isArray(emulators)) {
        args = args.concat('--only', emulators.join(','));
      }

      if (debug) {
        args.push('--debug');
      }

      const spawnOptions = {
        cwd: workspacePath,
        windowsHide: true
      };

      // TODO: This is only while developing!
      const devFirebaseTools = '/home/josep/projects/firebase-tools';
      args = [devFirebaseTools + '/lib/bin/firebase.js', ...args];
      cliProcess = spawn('node' /* TODO: 'firebase' */, args, spawnOptions);
      // cliProcess = spawn('firebase' */, args, spawnOptions);

      cliProcess.once('exit', (code, signal) => {
        console.log('ChildProcess exit:', code, signal);
        cliProcess = undefined;
        resolve();
      });
    } catch (err) {
      console.error('Error while starting the emulators:', err);
      await stopEmulators();
      resolve();
    }
  });
}

export async function stopEmulators(): Promise<void> {
  if (cliProcess) {
    if (cliProcess.killed) {
      cliProcess = undefined;
      return;
    }

    return new Promise(resolve => {
      cliProcess!.once('exit', () => {
        cliProcess = undefined;
        resolve();
      });
      cliProcess!.kill('SIGINT');
    });
  }
}

export async function listAllProjects(): Promise<
  Array<{
    email: string;
    projects: FirebaseProject[];
  }>
> {
  const accounts = AccountManager.getAccounts();
  const accountsWithProjects: Array<{
    email: string;
    projects: FirebaseProject[];
  }> = [];

  await Promise.all(
    accounts.map(async account => {
      const projects = await AccountManager.for(account).listProjects({
        refresh: false
      });
      accountsWithProjects.push({ email: account.user.email, projects });
    })
  );

  return accountsWithProjects;
}

export async function prepareServerStart(
  server: WebSocketServer,
  data: {
    path: string;
    email: string;
    projectId: string;
    emulators: 'all' | string[];
    debug: boolean;
  }
): Promise<void> {
  server.on('stdout', line => {
    if (webviewPanels.emulators) {
      postToPanel(webviewPanels.emulators, {
        command: 'stdout',
        message: linkify(ansiToHTML(line))
      });
    }
  });

  server.on('stderr', line => {
    if (webviewPanels.emulators) {
      postToPanel(webviewPanels.emulators, {
        command: 'stderr',
        message: linkify(ansiToHTML(line))
      });
    }
  });

  server.on('log', logEntry => {
    if (webviewPanels.emulators) {
      postToPanel(webviewPanels.emulators, {
        command: 'log',
        message: logEntry
      });
    }
  });

  server.on('close', () => {
    server.clearListeners();
  });

  server.on('emulator-port-taken', async emulator => {
    let processInfo = await findWhoHasPort(emulator.addr.port);
    postToPanel(webviewPanels.emulators!, {
      command: 'emulator-port-taken',
      emulator,
      processInfo
    });
  });

  const { path, email, projectId, emulators, debug } = data;

  // This promise resolves when the child process exits
  await startEmulators(server, path, email, projectId, emulators, debug);
  // The CLI has exited

  if (webviewPanels.emulators) {
    postToPanel(webviewPanels.emulators, { command: 'stopped' });
    server.clearListeners();
  }
}

export async function findWhoHasPort(
  port: number | string
): Promise<PsNodeResult | undefined> {
  try {
    const pid = await findPidByPort(port);

    if (!pid) {
      return;
    }

    return new Promise(resolve => {
      psNode.lookup({ pid }, (err: string | null, results: PsNodeResult[]) => {
        if (err || !results || results.length === 0) {
          resolve();
        } else {
          resolve(results[0]);
        }
      });
    });
  } catch (err) {
    return;
  }
}

export async function killProcess(pid: number | string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    // First we send a polite SIGINT with a 5 second timeout
    psNode.kill(
      pid,
      {
        signal: 'SIGINT',
        timeout: 5
      },
      (errSIGINT: any) => {
        if (!errSIGINT) {
          resolve(true);
        } else {
          // It didn't work. Let's try to be more blunt.
          psNode.kill(pid, 'SIGKILL', (errSIGKILL: any) => {
            resolve(errSIGKILL ? false : true);
          });
        }
      }
    );
  }).catch(() => {
    return false;
  });
}

export async function getProjectForFolder(
  path: string
): Promise<{ account: AccountInfo; project: FirebaseProject } | undefined> {
  if (vscode.workspace.workspaceFolders) {
    const { activeProjects } = Object.assign(
      { activeProjects: {} },
      await getCliConfig()
    );

    let useProjectId: string | undefined;

    if (contains(activeProjects, path)) {
      useProjectId = activeProjects[path];
    }

    const rcFiles = await vscode.workspace.findFiles(
      '.firebaserc',
      '**/​node_modules*'
    );
    const rcFile = rcFiles.find(rcFile => {
      // return new RegExp(`^${escapeRegExp(path)}`).test(rcFile.path);
      return dirname(rcFile.path) === path;
    });

    if (rcFile) {
      try {
        const firebaseRc = JSON.parse(await readFile(rcFile.path, 'utf8'));
        if (contains(firebaseRc, 'projects')) {
          if (useProjectId) {
            if (contains(firebaseRc.projects, useProjectId)) {
              useProjectId = firebaseRc.projects[useProjectId];
            }
          } else {
            if (contains(firebaseRc.projects, 'default')) {
              useProjectId = firebaseRc.projects.default;
            }
          }
        }
      } catch (err) {
        // Couldn't read or parse the `.firebaserc` file, no problem
      }
    }

    if (useProjectId) {
      let projectManager: ProjectManager | undefined;
      // Find an account that has access to the selected project
      const account = AccountManager.getAccounts().find(account => {
        try {
          projectManager = ProjectManager.for(account, useProjectId!);
          return true;
        } catch (err) {
          // This account doesn't have access
          return false;
        }
      });

      if (account && projectManager) {
        // Return the AccountInfo & FirebaseProject for the selected project
        return { account, project: projectManager.project };
      }
    }
  }

  // Couldn't determine the project to use
  return;
}
