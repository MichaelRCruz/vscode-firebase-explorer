import * as path from 'path';
import * as vscode from 'vscode';
import { AccountInfo } from '../accounts/AccountManager';
import { FirebaseProject } from '../projects/ProjectManager';
import { messageTreeItem } from '../utils';
import {
  HostingAPI,
  HostingRelease,
  HostingReleaseType,
  HostingSite,
  HostingVersionStatus
} from './api';
import { filesToTree, PathTreePart, sortTreeParts } from './utils';

const ASSETS_PATH = './assets';

export class HostingProvider
  implements vscode.TreeDataProvider<HostingProviderItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    HostingProviderItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(element?: HostingProviderItem): void {
    this._onDidChangeTreeData.fire(element);
  }

  getTreeItem(element: HostingProviderItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: HostingProviderItem
  ): Promise<HostingProviderItem[]> {
    const account = this.context.globalState.get<AccountInfo>(
      'selectedAccount'
    );
    const project = this.context.globalState.get<FirebaseProject>(
      'selectedProject'
    );

    if (project === null) {
      return [messageTreeItem('Loading...')];
    }

    if (!account || !project) {
      // No selected account or project
      return [];
    }

    const api = HostingAPI.for(account, project);

    if (!element) {
      let sites: HostingSite[];

      try {
        sites = await api.listSites();
      } catch (err) {
        return [
          messageTreeItem(
            'Failed to retrieve Hosting sites',
            `
              Something went wrong while retrieving the list of
              Firebase Hosting sites for this project.
            `,
            'alert'
          )
        ];
      }

      if (sites.length === 0) {
        return [
          messageTreeItem(
            'No Firebase Hosting sites for this project',
            `
              There are no deployed functions for this project.
              Refresh to fetch any updates.
            `
          )
        ];
      } else if (sites.length === 1) {
        return releasesForSite(account, project, api, sites[0]);
      } else {
        return sites.map(site => new HostingSiteItem(account, project, site));
      }
    } else if (element instanceof HostingSiteItem) {
      return releasesForSite(account, project, api, element.site);
    } else if (element instanceof HostingReleaseItem) {
      const files = await api.listFiles(element.release.version.name);
      const parts = sortTreeParts(filesToTree(files));
      return parts.map(part =>
        treePartToItem(part, account, project, element.release)
      );
    } else if (element instanceof HostingFolderItem) {
      return sortTreeParts(element.part.children).map(part =>
        treePartToItem(part, account, project, element.release)
      );
    } else {
      return [];
    }
  }
}

export class HostingSiteItem extends vscode.TreeItem {
  contextValue = `hosting.site`;
  iconPath = {
    dark: path.resolve(ASSETS_PATH, `hosting/dark/site.svg`),
    light: path.resolve(ASSETS_PATH, `hosting/light/site.svg`)
  };

  constructor(
    public account: AccountInfo,
    public project: FirebaseProject,
    public site: HostingSite
  ) {
    super(site.site, vscode.TreeItemCollapsibleState.Collapsed);
  }

  get tooltip(): string {
    return this.label!;
  }
}

export class HostingReleaseItem extends vscode.TreeItem {
  contextValue = `hosting.release`;

  constructor(
    public account: AccountInfo,
    public project: FirebaseProject,
    public release: HostingRelease,
    public activeVersion: string
  ) {
    super(release.releaseTime, vscode.TreeItemCollapsibleState.Collapsed);

    if (release.type === HostingReleaseType.ROLLBACK) {
      this.iconPath = {
        dark: path.resolve(ASSETS_PATH, `hosting/dark/rolledback.svg`),
        light: path.resolve(ASSETS_PATH, `hosting/light/rolledback.svg`)
      };
    } else if (release.version.status === HostingVersionStatus.DELETED) {
      this.label = `<i>${this.label}</i>`;
      this.collapsibleState = vscode.TreeItemCollapsibleState.None;
      this.iconPath = {
        dark: path.resolve(ASSETS_PATH, `hosting/dark/deleted.svg`),
        light: path.resolve(ASSETS_PATH, `hosting/light/deleted.svg`)
      };
    } else if (release.version.name === activeVersion) {
      this.iconPath = path.resolve(ASSETS_PATH, `hosting/release-active.svg`);
    } else {
      this.iconPath = {
        dark: path.resolve(ASSETS_PATH, `hosting/dark/deployed.svg`),
        light: path.resolve(ASSETS_PATH, `hosting/light/deployed.svg`)
      };
    }
  }

  get tooltip(): string {
    return this.release.releaseTime;
  }
}

export class HostingFolderItem extends vscode.TreeItem {
  contextValue = `hosting.release.folder`;
  iconPath = vscode.ThemeIcon.Folder;
  collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;

  constructor(public release: HostingRelease, public part: PathTreePart) {
    super(part.name);
    this.resourceUri = vscode.Uri.file(part.name);
  }
}

export class HostingFileItem extends vscode.TreeItem {
  contextValue = `hosting.release.file`;
  iconPath = vscode.ThemeIcon.File;
  collapsibleState = vscode.TreeItemCollapsibleState.None;
  command = {
    command: 'firebaseExplorer.hosting.openFile',
    title: 'Open this file',
    arguments: [this]
  };

  constructor(
    public account: AccountInfo,
    public project: FirebaseProject,
    public release: HostingRelease,
    public part: PathTreePart
  ) {
    super(part.name);
    this.resourceUri = vscode.Uri.file(part.name);
  }
}

export type HostingProviderItem =
  | HostingSiteItem
  | HostingReleaseItem
  | HostingFolderItem
  | HostingFileItem;

function treePartToItem(
  part: PathTreePart,
  account: AccountInfo,
  project: FirebaseProject,
  release: HostingRelease
): HostingFolderItem | HostingFileItem {
  {
    if (part.file) {
      return new HostingFileItem(account, project, release, part);
    } else {
      return new HostingFolderItem(release, part);
    }
  }
}

async function releasesForSite(
  account: AccountInfo,
  project: FirebaseProject,
  api: HostingAPI,
  site: HostingSite
): Promise<HostingReleaseItem[]> {
  const releases = await api.listReleases(site.site);
  if (releases.length === 0) {
    return [
      messageTreeItem(
        'No releases for this site',
        'There are no deployed releases for this Firebase Hosting site. Refresh to fetch any updates.'
      ) as HostingReleaseItem
    ];
  } else {
    if (releases.length > 0) {
      const activeVersion = releases[0].version.name;
      return releases.map(
        release =>
          new HostingReleaseItem(account, project, release, activeVersion)
      );
    } else {
      return [];
    }
  }
}
