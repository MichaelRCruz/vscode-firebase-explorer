import { contains, setContext, ContextValue } from '../utils';
import { AccountManager, AccountInfo } from '../accounts/AccountManager';
import { IosApp, AndroidApp } from '../apps/apps';
import { ProjectsAPI } from './api';
import { AppsAPI } from '../apps/api';

const instances: { [k: string]: ProjectManager } = {};

export class ProjectManager {
  static for(
    account: AccountInfo | string,
    project: FirebaseProject | string
  ): ProjectManager {
    if (typeof account === 'string') {
      // "account" is an email, let's find the AccountInfo.
      const foundAccount = AccountManager.getAccounts().find(
        _account => _account.user.email === account
      );

      if (!foundAccount) {
        throw new Error('Account not found for email ' + account);
      }

      account = foundAccount;
    }

    if (typeof project === 'string') {
      // "project" is the projectId, let's find the FirebaseProject.
      const projects = AccountManager.for(account).listProjectsSync();

      if (!projects) {
        throw new Error('No projects found for email ' + account);
      }

      const foundProject = projects.find(
        _project => _project.projectId === project
      );

      if (!foundProject) {
        throw new Error('Project not found for projectId ' + project);
      }

      project = foundProject;
    }

    const id = account.user.email + '--' + project.projectId;
    if (!contains(instances, id)) {
      instances[id] = new ProjectManager(account, project);
    }
    return instances[id];
  }

  readonly accountManager: AccountManager;
  private config?: ProjectConfig;
  private webAppConfig?: WebAppConfig;
  private apps?: ProjectApps;

  private constructor(
    account: AccountInfo,
    public readonly project: FirebaseProject
  ) {
    this.accountManager = AccountManager.for(account);
  }

  getAccessToken(): Promise<string> {
    return this.accountManager.getAccessToken();
  }

  async getConfig(): Promise<ProjectConfig> {
    if (!this.config) {
      const api = ProjectsAPI.for(this.accountManager.account);
      this.config = await api.getProjectConfig(this.project);
    }
    return this.config;
  }

  async getWebAppConfig(): Promise<WebAppConfig> {
    if (!this.webAppConfig) {
      const api = ProjectsAPI.for(this.accountManager.account);
      this.webAppConfig = await api.getWebAppConfig(this.project);
    }
    return this.webAppConfig;
  }

  async listApps(forceRefresh = false): Promise<ProjectApps> {
    try {
      if (!this.apps || forceRefresh) {
        const apps = await Promise.all([
          this.listIosApps(),
          this.listAndroidApps()
        ]);

        this.apps = {
          ios: apps[0],
          android: apps[1]
        };
      }

      setContext(ContextValue.AppsLoaded, true);
      return this.apps;
    } catch (err) {
      // TODO: handle error
      console.error('apps', { err });
      console.log((err as Error).stack);
      return {
        ios: [],
        android: []
      };
    }
  }

  // async listApps_old(forceRefresh = false): Promise<ProjectApps> {
  //   try {
  //     if (!this.apps || forceRefresh) {
  //       await this.initialized;

  //       const management = firebaseAdmin.projectManagement(this.firebaseApp);
  //       const apps = await Promise.all([
  //         management.listIosApps(),
  //         management.listAndroidApps()
  //       ]);

  //       const projectApps = await Promise.all([
  //         Promise.all(
  //           apps[0].map(async iosApp => {
  //             const metadata = await iosApp.getMetadata();
  //             return { app: iosApp, metadata };
  //           })
  //         ),
  //         Promise.all(
  //           apps[1].map(async androidApp => {
  //             const metadata = await androidApp.getMetadata();
  //             return { app: androidApp, metadata };
  //           })
  //         )
  //       ]);

  //       this.apps = {
  //         ios: projectApps[0],
  //         android: projectApps[1]
  //       };
  //     }

  //     setContext(ContextValue.AppsLoaded, true);

  //     return this.apps!;
  //   } catch (err) {
  //     // TODO: handle error
  //     console.error('apps', { err });
  //     return {
  //       ios: [],
  //       android: []
  //     };
  //   }
  // }

  private async listIosApps(): Promise<IosApp[]> {
    const api = AppsAPI.for(this.accountManager.account, this.project);
    const apps = await api.listIosApps(this.project.projectId);
    return apps.map(
      props => new IosApp(this.accountManager.account, this.project, props)
    );
  }

  private async listAndroidApps(): Promise<AndroidApp[]> {
    const api = AppsAPI.for(this.accountManager.account, this.project);
    const apps = await api.listAndroidApps(this.project.projectId);
    return apps.map(
      props => new AndroidApp(this.accountManager.account, this.project, props)
    );
  }
}

export interface ProjectApps {
  ios: IosApp[];
  android: AndroidApp[];
}

export interface FirebaseProject {
  projectId: string;
  projectNumber: string;
  displayName: string;
}

// export interface FirebaseProject {
//   displayName: string;
//   projectId: string;
//   projectNumber: string;
//   resources: {
//     hostingSite: string;
//     realtimeDatabaseInstance: string;
//     storageBucket: string;
//     locationId: string;
//   };
// }

export interface ProjectConfig {
  projectId: string;
  databaseURL: string;
  storageBucket: string;
  locationId: string;
}

export interface ProjectInfo {
  projectId: string;
  displayName: string;
  locationId: string;
}

export interface WebAppConfig {
  // TODO: apiKey, databaseURL, etc.
  [k: string]: any;
}
