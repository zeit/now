import url, { URL } from 'url';
import http from 'http';
import fs from 'fs-extra';
import chalk from 'chalk';
import plural from 'pluralize';
import rawBody from 'raw-body';
import listen from 'async-listen';
import minimatch from 'minimatch';
import ms from 'ms';
import httpProxy from 'http-proxy';
import { randomBytes } from 'crypto';
import serveHandler from 'serve-handler';
import { watch, FSWatcher } from 'chokidar';
import { parse as parseDotenv } from 'dotenv';
import path, { isAbsolute, basename, dirname, extname, join } from 'path';
import once from '@tootallnate/once';
import directoryTemplate from 'serve-handler/src/directory';
import getPort from 'get-port';
import { ChildProcess } from 'child_process';
import isPortReachable from 'is-port-reachable';
import deepEqual from 'fast-deep-equal';
import which from 'which';
import npa from 'npm-package-arg';

import { getVercelIgnore, fileNameSymbol } from '@vercel/client';
import {
  getTransformedRoutes,
  appendRoutesToPhase,
  HandleValue,
  Route,
} from '@vercel/routing-utils';
import {
  Builder,
  Env,
  FileFsRef,
  PackageJson,
  detectBuilders,
  detectApiDirectory,
  detectApiExtensions,
  spawnCommand,
  isOfficialRuntime,
} from '@vercel/build-utils';
import frameworkList from '@vercel/frameworks';

import cmd from '../output/cmd';
import link from '../output/link';
import sleep from '../sleep';
import { Output } from '../output';
import { relative } from '../path-helpers';
import { getDistTag } from '../get-dist-tag';
import getVercelConfigPath from '../config/local-path';
import { MissingDotenvVarsError } from '../errors-ts';
import cliPkg from '../pkg';
import { getVercelDirectory } from '../projects/link';
import { staticFiles as getFiles } from '../get-files';
import { validateConfig } from './validate';
import { devRouter, getRoutesTypes } from './router';
import getMimeType from './mime-type';
import { executeBuild, getBuildMatches, shutdownBuilder } from './builder';
import { generateErrorMessage, generateHttpStatusDescription } from './errors';
import {
  installBuilders,
  updateBuilders,
  builderDirPromise,
} from './builder-cache';

// HTML templates
import errorTemplate from './templates/error';
import errorTemplateBase from './templates/error_base';
import errorTemplate404 from './templates/error_404';
import errorTemplate502 from './templates/error_502';
import redirectTemplate from './templates/redirect';

import {
  VercelConfig,
  DevServerOptions,
  BuildMatch,
  BuildResult,
  BuilderInputs,
  BuilderOutput,
  HttpHandler,
  InvokePayload,
  InvokeResult,
  ListenSpec,
  RouteResult,
  HttpHeadersConfig,
  EnvConfigs,
} from './types';
import { ProjectEnvVariable, ProjectSettings } from '../../types';
import exposeSystemEnvs from './expose-system-envs';

const frontendRuntimeSet = new Set(
  frameworkList.map(f => f.useRuntime?.use || '@vercel/static-build')
);

interface FSEvent {
  type: string;
  path: string;
}

type WithFileNameSymbol<T> = T & {
  [fileNameSymbol]: string;
};

function sortBuilders(buildA: Builder, buildB: Builder) {
  if (buildA && buildA.use && isOfficialRuntime('static-build', buildA.use)) {
    return 1;
  }

  if (buildB && buildB.use && isOfficialRuntime('static-build', buildB.use)) {
    return -1;
  }

  return 0;
}

export default class DevServer {
  public cwd: string;
  public debug: boolean;
  public output: Output;
  public proxy: httpProxy;
  public envConfigs: EnvConfigs;
  public frameworkSlug?: string;
  public files: BuilderInputs;
  public address: string;
  public devCacheDir: string;

  private caseSensitive: boolean;
  private apiDir: string | null;
  private apiExtensions: Set<string>;
  private server: http.Server;
  private stopping: boolean;
  private buildMatches: Map<string, BuildMatch>;
  private inProgressBuilds: Map<string, Promise<void>>;
  private watcher?: FSWatcher;
  private watchAggregationId: NodeJS.Timer | null;
  private watchAggregationEvents: FSEvent[];
  private watchAggregationTimeout: number;
  private filter: (path: string) => boolean;
  private podId: string;
  private devCommand?: string;
  private devProcess?: ChildProcess;
  private devProcessPort?: number;
  private devServerPids: Set<number>;
  private projectSettings?: ProjectSettings;

  private vercelConfigWarning: boolean;
  private getVercelConfigPromise: Promise<VercelConfig> | null;
  private blockingBuildsPromise: Promise<void> | null;
  private updateBuildersPromise: Promise<void> | null;
  private updateBuildersTimeout: NodeJS.Timeout | undefined;
  private startPromise: Promise<void> | null;

  private systemEnvValues: string[];
  private projectEnvs: ProjectEnvVariable[];

  constructor(cwd: string, options: DevServerOptions) {
    this.cwd = cwd;
    this.debug = options.debug;
    this.output = options.output;
    this.envConfigs = { buildEnv: {}, runEnv: {}, allEnv: {} };
    this.systemEnvValues = options.systemEnvValues || [];
    this.projectEnvs = options.projectEnvs || [];
    this.files = {};
    this.address = '';
    this.devCommand = options.devCommand;
    this.projectSettings = options.projectSettings;
    this.frameworkSlug = options.frameworkSlug;
    this.caseSensitive = false;
    this.apiDir = null;
    this.apiExtensions = new Set();
    this.proxy = httpProxy.createProxyServer({
      changeOrigin: true,
      ws: true,
      xfwd: true,
    });
    this.server = http.createServer(this.devServerHandler);
    this.server.timeout = 0; // Disable timeout
    this.stopping = false;
    this.buildMatches = new Map();
    this.inProgressBuilds = new Map();
    this.devCacheDir = join(getVercelDirectory(cwd), 'cache');

    this.vercelConfigWarning = false;
    this.getVercelConfigPromise = null;
    this.blockingBuildsPromise = null;
    this.updateBuildersPromise = null;
    this.startPromise = null;

    this.watchAggregationId = null;
    this.watchAggregationEvents = [];
    this.watchAggregationTimeout = 500;

    this.filter = path => Boolean(path);
    this.podId = Math.random().toString(32).slice(-5);

    this.devServerPids = new Set();
  }

  async exit(code = 1) {
    await this.stop(code);
    process.exit(code);
  }

  enqueueFsEvent(type: string, path: string): void {
    this.watchAggregationEvents.push({ type, path });
    if (this.watchAggregationId === null) {
      this.watchAggregationId = setTimeout(() => {
        const events = this.watchAggregationEvents.slice();
        this.watchAggregationEvents.length = 0;
        this.watchAggregationId = null;
        this.handleFilesystemEvents(events);
      }, this.watchAggregationTimeout);
    }
  }

  async handleFilesystemEvents(events: FSEvent[]): Promise<void> {
    this.output.debug(`Filesystem watcher notified of ${events.length} events`);

    const filesChanged: Set<string> = new Set();
    const filesRemoved: Set<string> = new Set();

    const distPaths: string[] = [];

    for (const buildMatch of this.buildMatches.values()) {
      for (const buildResult of buildMatch.buildResults.values()) {
        if (buildResult.distPath) {
          distPaths.push(buildResult.distPath);
        }
      }
    }

    events = events.filter(event =>
      distPaths.every(distPath => !event.path.startsWith(distPath))
    );

    // First, update the `files` mapping of source files
    for (const event of events) {
      if (event.type === 'add') {
        await this.handleFileCreated(event.path, filesChanged, filesRemoved);
      } else if (event.type === 'unlink') {
        this.handleFileDeleted(event.path, filesChanged, filesRemoved);
      } else if (event.type === 'change') {
        await this.handleFileModified(event.path, filesChanged, filesRemoved);
      }
    }

    const vercelConfig = await this.getVercelConfig();

    // Update the build matches in case an entrypoint was created or deleted
    await this.updateBuildMatches(vercelConfig);

    const filesChangedArray = [...filesChanged];
    const filesRemovedArray = [...filesRemoved];

    // Trigger rebuilds of any existing builds that are dependent
    // on one of the files that has changed
    const needsRebuild: Map<BuildResult, [string | null, BuildMatch]> =
      new Map();

    for (const match of this.buildMatches.values()) {
      for (const [requestPath, result] of match.buildResults) {
        // If the `BuildResult` is already queued for a re-build,
        // then we can skip subsequent lookups
        if (needsRebuild.has(result)) continue;

        if (Array.isArray(result.watch)) {
          for (const pattern of result.watch) {
            if (
              minimatches(filesChangedArray, pattern) ||
              minimatches(filesRemovedArray, pattern)
            ) {
              needsRebuild.set(result, [requestPath, match]);
              break;
            }
          }
        }
      }
    }

    if (needsRebuild.size > 0) {
      this.output.debug(`Triggering ${needsRebuild.size} rebuilds`);
      if (filesChangedArray.length > 0) {
        this.output.debug(`Files changed: ${filesChangedArray.join(', ')}`);
      }
      if (filesRemovedArray.length > 0) {
        this.output.debug(`Files removed: ${filesRemovedArray.join(', ')}`);
      }
      for (const [result, [requestPath, match]] of needsRebuild) {
        if (
          requestPath === null ||
          (await shouldServe(
            match,
            this.files,
            requestPath,
            this,
            vercelConfig
          ))
        ) {
          this.triggerBuild(
            match,
            requestPath,
            null,
            vercelConfig,
            result,
            filesChangedArray,
            filesRemovedArray
          ).catch((err: Error) => {
            this.output.warn(
              `An error occurred while rebuilding \`${match.src}\`:`
            );
            console.error(err.stack);
          });
        } else {
          this.output.debug(
            `Not rebuilding because \`shouldServe()\` returned \`false\` for "${match.use}" request path "${requestPath}"`
          );
        }
      }
    }

    // Since there was a filesystem event, all currently running
    // Serverless Function dev server processes need to be invalidated,
    // so that a new process will be created on the next HTTP request
    for (const match of this.buildMatches.values()) {
      const devServerResult = await match.devServerResultPromise;
      if (devServerResult) {
        await this.killBuilderDevServer(devServerResult.pid);
        delete match.devServerResultPromise;
      }
    }
  }

  async handleFileCreated(
    fsPath: string,
    changed: Set<string>,
    removed: Set<string>
  ): Promise<void> {
    const name = relative(this.cwd, fsPath);
    try {
      this.files[name] = await FileFsRef.fromFsPath({ fsPath });
      const extensionless = this.getExtensionlessFile(name);
      if (extensionless) {
        this.files[extensionless] = await FileFsRef.fromFsPath({ fsPath });
      }
      fileChanged(name, changed, removed);
      this.output.debug(`File created: ${name}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.output.debug(`File created, but has since been deleted: ${name}`);
        fileRemoved(name, this.files, changed, removed);
      } else {
        throw err;
      }
    }
  }

  handleFileDeleted(
    fsPath: string,
    changed: Set<string>,
    removed: Set<string>
  ): void {
    const name = relative(this.cwd, fsPath);
    this.output.debug(`File deleted: ${name}`);
    fileRemoved(name, this.files, changed, removed);
    const extensionless = this.getExtensionlessFile(name);
    if (extensionless) {
      this.output.debug(`File deleted: ${extensionless}`);
      fileRemoved(extensionless, this.files, changed, removed);
    }
  }

  async handleFileModified(
    fsPath: string,
    changed: Set<string>,
    removed: Set<string>
  ): Promise<void> {
    const name = relative(this.cwd, fsPath);
    try {
      this.files[name] = await FileFsRef.fromFsPath({ fsPath });
      fileChanged(name, changed, removed);
      this.output.debug(`File modified: ${name}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.output.debug(`File modified, but has since been deleted: ${name}`);
        fileRemoved(name, this.files, changed, removed);
      } else {
        throw err;
      }
    }
  }

  async updateBuildMatches(
    vercelConfig: VercelConfig,
    isInitial = false
  ): Promise<void> {
    const fileList = this.resolveBuildFiles(this.files);
    const matches = await getBuildMatches(
      vercelConfig,
      this.cwd,
      this.output,
      this,
      fileList
    );
    const sources = matches.map(m => m.src);

    if (isInitial && fileList.length === 0) {
      this.output.warn('There are no files inside your deployment.');
    }

    // Delete build matches that no longer exists
    const ops: Promise<void>[] = [];
    for (const src of this.buildMatches.keys()) {
      if (!sources.includes(src)) {
        this.output.debug(`Removing build match for "${src}"`);
        const match = this.buildMatches.get(src);
        if (match) {
          ops.push(shutdownBuilder(match, this.output));
        }
        this.buildMatches.delete(src);
      }
    }
    await Promise.all(ops);

    // Add the new matches to the `buildMatches` map
    const blockingBuilds: Promise<void>[] = [];
    for (const match of matches) {
      const currentMatch = this.buildMatches.get(match.src);
      if (!buildMatchEquals(currentMatch, match)) {
        this.output.debug(
          `Adding build match for "${match.src}" with "${match.use}"`
        );
        this.buildMatches.set(match.src, match);
        if (!isInitial && needsBlockingBuild(match)) {
          const buildPromise = executeBuild(
            vercelConfig,
            this,
            this.files,
            match,
            null,
            false
          );
          blockingBuilds.push(buildPromise);
        }
      }
    }

    if (blockingBuilds.length > 0) {
      this.output.debug(
        `Waiting for ${blockingBuilds.length} "blocking builds"`
      );
      this.blockingBuildsPromise = Promise.all(blockingBuilds)
        .then(() => {
          this.output.debug(
            `Cleaning up "blockingBuildsPromise" after successful resolve`
          );
          this.blockingBuildsPromise = null;
        })
        .catch((err?: Error) => {
          this.output.debug(
            `Cleaning up "blockingBuildsPromise" after error: ${err}`
          );
          this.blockingBuildsPromise = null;
          if (err) {
            this.output.prettyError(err);
          }
        });
    }

    // Sort build matches to make sure `@vercel/static-build` is always last
    this.buildMatches = new Map(
      [...this.buildMatches.entries()].sort((matchA, matchB) => {
        return sortBuilders(matchA[1] as Builder, matchB[1] as Builder);
      })
    );
  }

  async invalidateBuildMatches(
    vercelConfig: VercelConfig,
    updatedBuilders: string[]
  ): Promise<void> {
    if (updatedBuilders.length === 0) {
      this.output.debug('No builders were updated');
      return;
    }

    // Delete any build matches that have the old builder required already
    for (const buildMatch of this.buildMatches.values()) {
      const {
        src,
        builderWithPkg: { package: pkg },
      } = buildMatch;
      if (isOfficialRuntime('static', pkg.name)) continue;
      if (pkg.name && updatedBuilders.includes(pkg.name)) {
        shutdownBuilder(buildMatch, this.output);
        this.buildMatches.delete(src);
        this.output.debug(`Invalidated build match for "${src}"`);
      }
    }

    // Re-add the build matches that were just removed, but with the new builder
    await this.updateBuildMatches(vercelConfig);
  }

  async getLocalEnv(fileName: string, base?: Env): Promise<Env> {
    // TODO: use the file watcher to only invalidate the env `dotfile`
    // once a change to the `fileName` occurs
    const filePath = join(this.cwd, fileName);
    let env: Env = {};
    try {
      const dotenv = await fs.readFile(filePath, 'utf8');
      this.output.debug(`Using local env: ${filePath}`);
      env = parseDotenv(dotenv);
      env = this.injectSystemValuesInDotenv(env);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
    try {
      return {
        ...this.validateEnvConfig(fileName, base || {}, env),
      };
    } catch (err) {
      if (err instanceof MissingDotenvVarsError) {
        this.output.error(err.message);
        await this.exit();
      } else {
        throw err;
      }
    }
    return {};
  }

  clearVercelConfigPromise = () => {
    this.getVercelConfigPromise = null;
  };

  getVercelConfig(): Promise<VercelConfig> {
    if (this.getVercelConfigPromise) {
      return this.getVercelConfigPromise;
    }
    this.getVercelConfigPromise = this._getVercelConfig();

    // Clean up the promise once it has resolved
    const clear = this.clearVercelConfigPromise;
    this.getVercelConfigPromise.finally(clear);

    return this.getVercelConfigPromise;
  }

  async _getVercelConfig(): Promise<VercelConfig> {
    const configPath = getVercelConfigPath(this.cwd);

    const [
      pkg = null,
      // The default empty `vercel.json` is used to serve all
      // files as static when no `vercel.json` is present
      vercelConfig = { version: 2, [fileNameSymbol]: 'vercel.json' },
    ] = await Promise.all([
      this.readJsonFile<PackageJson>('package.json'),
      this.readJsonFile<VercelConfig>(configPath),
    ]);

    await this.validateVercelConfig(vercelConfig);
    const { error: routeError, routes: maybeRoutes } = getTransformedRoutes({
      nowConfig: vercelConfig,
    });
    if (routeError) {
      this.output.prettyError(routeError);
      await this.exit();
    }
    vercelConfig.routes = maybeRoutes || [];

    // no builds -> zero config
    if (!vercelConfig.builds || vercelConfig.builds.length === 0) {
      const featHandleMiss = true; // enable for zero config
      const { projectSettings, cleanUrls, trailingSlash } = vercelConfig;

      const opts = { output: this.output };
      const files = (await getFiles(this.cwd, opts)).map(f =>
        relative(this.cwd, f)
      );

      let {
        builders,
        warnings,
        errors,
        defaultRoutes,
        redirectRoutes,
        rewriteRoutes,
        errorRoutes,
      } = await detectBuilders(files, pkg, {
        tag: getDistTag(cliPkg.version) === 'canary' ? 'canary' : 'latest',
        functions: vercelConfig.functions,
        projectSettings: projectSettings || this.projectSettings,
        featHandleMiss,
        cleanUrls,
        trailingSlash,
      });

      if (errors) {
        this.output.error(errors[0].message);
        await this.exit();
      }

      if (warnings && warnings.length > 0) {
        warnings.forEach(warning =>
          this.output.warn(warning.message, null, warning.link, warning.action)
        );
      }

      if (builders) {
        if (this.devCommand) {
          builders = builders.filter(filterFrontendBuilds);
        }

        vercelConfig.builds = vercelConfig.builds || [];
        vercelConfig.builds.push(...builders);

        delete vercelConfig.functions;
      }

      let routes: Route[] = [];
      routes.push(...(redirectRoutes || []));
      routes.push(
        ...appendRoutesToPhase({
          routes: vercelConfig.routes,
          newRoutes: rewriteRoutes,
          phase: 'filesystem',
        })
      );
      routes = appendRoutesToPhase({
        routes,
        newRoutes: errorRoutes,
        phase: 'error',
      });
      routes.push(...(defaultRoutes || []));
      vercelConfig.routes = routes;
    }

    if (Array.isArray(vercelConfig.builds)) {
      if (this.devCommand) {
        vercelConfig.builds = vercelConfig.builds.filter(filterFrontendBuilds);
      }

      // `@vercel/static-build` needs to be the last builder
      // since it might catch all other requests
      vercelConfig.builds.sort(sortBuilders);
    }

    await this.validateVercelConfig(vercelConfig);

    // TODO: temporarily strip and warn since `has` is not implemented yet
    vercelConfig.routes = (vercelConfig.routes || []).filter(route => {
      if ('has' in route) {
        if (!this.vercelConfigWarning) {
          this.vercelConfigWarning = true;
          this.output.warn(
            `The "has" property in ${vercelConfig[fileNameSymbol]} will be ignored during development. Deployments will work as expected.`
          );
        }
        return false;
      }
      return true;
    });

    this.caseSensitive = hasNewRoutingProperties(vercelConfig);
    this.apiDir = detectApiDirectory(vercelConfig.builds || []);
    this.apiExtensions = detectApiExtensions(vercelConfig.builds || []);

    // Update the env vars configuration
    let [runEnv, buildEnv] = await Promise.all([
      this.getLocalEnv('.env', vercelConfig.env),
      this.getLocalEnv('.env.build', vercelConfig.build?.env),
    ]);

    let allEnv = { ...buildEnv, ...runEnv };

    // If no .env/.build.env is present, use cloud environment variables
    if (Object.keys(allEnv).length === 0) {
      const cloudEnv = exposeSystemEnvs(
        this.projectEnvs || [],
        this.systemEnvValues || [],
        this.projectSettings?.autoExposeSystemEnvs,
        new URL(this.address).host
      );

      allEnv = { ...cloudEnv };
      runEnv = { ...cloudEnv };
      buildEnv = { ...cloudEnv };
    }

    // legacy NOW_REGION env variable
    runEnv['NOW_REGION'] = 'dev1';
    buildEnv['NOW_REGION'] = 'dev1';
    allEnv['NOW_REGION'] = 'dev1';

    // mirror how VERCEL_REGION is injected in prod/preview
    // only inject in `runEnvs`, because `allEnvs` is exposed to dev command
    // and should not contain VERCEL_REGION
    if (this.projectSettings?.autoExposeSystemEnvs) {
      runEnv['VERCEL_REGION'] = 'dev1';
    }

    this.envConfigs = { buildEnv, runEnv, allEnv };
    return vercelConfig;
  }

  async readJsonFile<T>(
    filePath: string
  ): Promise<WithFileNameSymbol<T> | void> {
    let rel, abs;
    if (isAbsolute(filePath)) {
      rel = path.relative(this.cwd, filePath);
      abs = filePath;
    } else {
      rel = filePath;
      abs = join(this.cwd, filePath);
    }
    this.output.debug(`Reading \`${rel}\` file`);

    try {
      const raw = await fs.readFile(abs, 'utf8');
      const parsed: WithFileNameSymbol<T> = JSON.parse(raw);
      parsed[fileNameSymbol] = rel;
      return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.output.debug(`No \`${rel}\` file present`);
      } else if (err.name === 'SyntaxError') {
        this.output.warn(
          `There is a syntax error in the \`${rel}\` file: ${err.message}`
        );
      } else {
        throw err;
      }
    }
  }

  async tryValidateOrExit(
    config: VercelConfig,
    validate: (c: VercelConfig) => string | null
  ): Promise<void> {
    const message = validate(config);

    if (message) {
      this.output.error(message);
      await this.exit(1);
    }
  }

  async validateVercelConfig(config: VercelConfig): Promise<void> {
    if (config.version === 1) {
      this.output.error('Cannot run `version: 1` projects.');
      await this.exit(1);
      return;
    }

    const error = validateConfig(config);

    if (error) {
      this.output.prettyError(error);
      await this.exit(1);
    }
  }

  validateEnvConfig(type: string, env: Env = {}, localEnv: Env = {}): Env {
    // Validate if there are any missing env vars defined in `vercel.json`,
    // but not in the `.env` / `.build.env` file
    const missing: string[] = Object.entries(env)
      .filter(
        ([name, value]) =>
          typeof value === 'string' &&
          value.startsWith('@') &&
          !hasOwnProperty(localEnv, name)
      )
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new MissingDotenvVarsError(type, missing);
    }

    const merged: Env = { ...env, ...localEnv };

    // Validate that the env var name matches what AWS Lambda allows:
    //   - https://docs.aws.amazon.com/lambda/latest/dg/env_variables.html
    let hasInvalidName = false;
    for (const key of Object.keys(merged)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
        this.output.warn(
          `Ignoring ${type
            .split('.')
            .slice(1)
            .reverse()
            .join(' ')} var ${JSON.stringify(key)} because name is invalid`
        );
        hasInvalidName = true;
        delete merged[key];
      }
    }
    if (hasInvalidName) {
      this.output.log(
        'Env var names must start with letters, and can only contain alphanumeric characters and underscores'
      );
    }

    return merged;
  }

  injectSystemValuesInDotenv(env: Env): Env {
    for (const name of Object.keys(env)) {
      if (name === 'VERCEL_URL') {
        env['VERCEL_URL'] = new URL(this.address).host;
      } else if (name === 'VERCEL_REGION') {
        env['VERCEL_REGION'] = 'dev1';
      }
    }

    return env;
  }

  /**
   * Create an array of from builder inputs
   * and filter them
   */
  resolveBuildFiles(files: BuilderInputs) {
    return Object.keys(files).filter(this.filter);
  }

  start(...listenSpec: ListenSpec): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this._start(...listenSpec).catch(err => {
        this.stop();
        throw err;
      });
    }
    return this.startPromise;
  }

  /**
   * Launches the `vercel dev` server.
   */
  async _start(...listenSpec: ListenSpec): Promise<void> {
    if (!fs.existsSync(this.cwd)) {
      throw new Error(`${chalk.bold(this.cwd)} doesn't exist`);
    }

    if (!fs.lstatSync(this.cwd).isDirectory()) {
      throw new Error(`${chalk.bold(this.cwd)} is not a directory`);
    }

    const { ig } = await getVercelIgnore(this.cwd);
    this.filter = ig.createFilter();

    let address: string | null = null;
    while (typeof address !== 'string') {
      try {
        address = await listen(this.server, ...listenSpec);
      } catch (err) {
        this.output.debug(`Got listen error: ${err.code}`);
        if (err.code === 'EADDRINUSE') {
          if (typeof listenSpec[0] === 'number') {
            // Increase port and try again
            this.output.note(
              `Requested port ${chalk.yellow(
                String(listenSpec[0])
              )} is already in use`
            );
            listenSpec[0]++;
          } else {
            this.output.error(
              `Requested socket ${chalk.cyan(listenSpec[0])} is already in use`
            );
            process.exit(1);
          }
        } else {
          throw err;
        }
      }
    }

    this.address = address
      .replace('[::]', 'localhost')
      .replace('127.0.0.1', 'localhost');

    const vercelConfig = await this.getVercelConfig();
    const devCommandPromise = this.runDevCommand();

    const files = await getFiles(this.cwd, { output: this.output });
    this.files = {};
    for (const fsPath of files) {
      let path = relative(this.cwd, fsPath);
      const { mode } = await fs.stat(fsPath);
      this.files[path] = new FileFsRef({ mode, fsPath });
      const extensionless = this.getExtensionlessFile(path);
      if (extensionless) {
        this.files[extensionless] = new FileFsRef({ mode, fsPath });
      }
    }

    const builders = new Set<string>(
      (vercelConfig.builds || [])
        .filter((b: Builder) => b.use)
        .map((b: Builder) => b.use)
    );

    await installBuilders(builders, this.output);
    await this.updateBuildMatches(vercelConfig, true);

    // Updating builders happens lazily, and any builders that were updated
    // get their "build matches" invalidated so that the new version is used.
    this.updateBuildersTimeout = setTimeout(() => {
      this.updateBuildersPromise = updateBuilders(builders, this.output)
        .then(updatedBuilders => {
          this.updateBuildersPromise = null;
          this.invalidateBuildMatches(vercelConfig, updatedBuilders);
        })
        .catch(err => {
          this.updateBuildersPromise = null;
          this.output.prettyError(err);
          this.output.debug(err.stack);
        });
    }, ms('30s'));

    // Builders that do not define a `shouldServe()` function need to be
    // executed at boot-up time in order to get the initial assets and/or routes
    // that can be served by the builder.
    const blockingBuilds = Array.from(this.buildMatches.values()).filter(
      needsBlockingBuild
    );
    if (blockingBuilds.length > 0) {
      this.output.log(
        `Creating initial ${plural('build', blockingBuilds.length)}`
      );

      for (const match of blockingBuilds) {
        await executeBuild(vercelConfig, this, this.files, match, null, true);
      }

      this.output.success('Build completed');
    }

    // Ensure that the dev cache directory exists so that runtimes
    // don't need to create it themselves.
    await fs.mkdirp(this.devCacheDir);

    // Start the filesystem watcher
    this.watcher = watch(this.cwd, {
      ignored: (path: string) => !this.filter(path),
      ignoreInitial: true,
      useFsEvents: false,
      usePolling: false,
      persistent: true,
    });
    this.watcher.on('add', (path: string) => {
      this.enqueueFsEvent('add', path);
    });
    this.watcher.on('change', (path: string) => {
      this.enqueueFsEvent('change', path);
    });
    this.watcher.on('unlink', (path: string) => {
      this.enqueueFsEvent('unlink', path);
    });
    this.watcher.on('error', (err: Error) => {
      this.output.error(`Watcher error: ${err}`);
    });

    // Wait for "ready" event of the watcher
    await once(this.watcher, 'ready');

    // Configure the server to forward WebSocket "upgrade" events to the proxy.
    this.server.on('upgrade', async (req, socket, head) => {
      await this.startPromise;
      if (!this.devProcessPort) {
        this.output.debug(
          `Detected "upgrade" event, but closing socket because no frontend dev server is running`
        );
        socket.destroy();
        return;
      }
      const target = `http://localhost:${this.devProcessPort}`;
      this.output.debug(`Detected "upgrade" event, proxying to ${target}`);
      this.proxy.ws(req, socket, head, { target });
    });

    await devCommandPromise;

    this.output.ready(`Available at ${link(this.address)}`);
  }

  /**
   * Shuts down the `vercel dev` server, and cleans up any temporary resources.
   */
  async stop(exitCode?: number): Promise<void> {
    const { devProcess } = this;
    const { debug } = this.output;
    if (this.stopping) return;

    this.stopping = true;

    if (typeof this.updateBuildersTimeout !== 'undefined') {
      clearTimeout(this.updateBuildersTimeout);
    }

    const ops: Promise<any>[] = [];

    for (const match of this.buildMatches.values()) {
      ops.push(shutdownBuilder(match, this.output));
    }

    if (devProcess) {
      ops.push(
        new Promise<void>((resolve, reject) => {
          devProcess.once('exit', () => resolve());
          try {
            process.kill(devProcess.pid);
          } catch (err) {
            if (err.code === 'ESRCH') {
              // Process already exited
              return resolve();
            }
            reject(err);
          }
        })
      );
    }

    ops.push(close(this.server));

    if (this.watcher) {
      debug(`Closing file watcher`);
      ops.push(this.watcher.close());
    }

    if (this.updateBuildersPromise) {
      debug(`Waiting for builders update to complete`);
      ops.push(this.updateBuildersPromise);
    }

    for (const pid of this.devServerPids) {
      ops.push(this.killBuilderDevServer(pid));
    }

    // Ensure that the builders module cache is created
    ops.push(builderDirPromise);

    try {
      await Promise.all(ops);
    } catch (err) {
      // Node 8 doesn't have a code for that error
      if (
        err.code === 'ERR_SERVER_NOT_RUNNING' ||
        err.message === 'Not running'
      ) {
        process.exit(exitCode || 0);
      } else {
        throw err;
      }
    }
  }

  async killBuilderDevServer(pid: number) {
    const { debug } = this.output;
    debug(`Killing builder dev server with PID ${pid}`);
    this.devServerPids.delete(pid);
    try {
      process.kill(pid, 'SIGTERM');
      debug(`Killed builder dev server with PID ${pid}`);
    } catch (err) {
      debug(`Failed to kill builder dev server with PID ${pid}: ${err}`);
    }
  }

  async send404(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestId: string
  ): Promise<void> {
    return this.sendError(req, res, requestId, 'NOT_FOUND', 404);
  }

  async sendError(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestId: string,
    errorCode?: string,
    statusCode: number = 500,
    headers: HttpHeadersConfig = {}
  ): Promise<void> {
    res.statusCode = statusCode;
    this.setResponseHeaders(res, requestId, headers);

    const http_status_description = generateHttpStatusDescription(statusCode);
    const error_code = errorCode || http_status_description;
    const errorMessage = generateErrorMessage(statusCode, error_code);

    let body: string;
    const { accept = 'text/plain' } = req.headers;
    if (accept.includes('json')) {
      res.setHeader('content-type', 'application/json');
      const json = JSON.stringify({
        error: {
          code: statusCode,
          message: errorMessage.title,
        },
      });
      body = `${json}\n`;
    } else if (accept.includes('html')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');

      let view: string;
      if (statusCode === 404) {
        view = errorTemplate404({
          ...errorMessage,
          http_status_code: statusCode,
          http_status_description,
          error_code,
          request_id: requestId,
        });
      } else if (statusCode === 502) {
        view = errorTemplate502({
          ...errorMessage,
          http_status_code: statusCode,
          http_status_description,
          error_code,
          request_id: requestId,
        });
      } else {
        view = errorTemplate({
          http_status_code: statusCode,
          http_status_description,
          request_id: requestId,
        });
      }
      body = errorTemplateBase({
        http_status_code: statusCode,
        http_status_description,
        view,
      });
    } else {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      body = `${errorMessage.title}\n\n${error_code}\n`;
    }
    res.end(body);
  }

  async sendRedirect(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestId: string,
    location: string,
    statusCode: number = 302
  ): Promise<void> {
    this.output.debug(`Redirect ${statusCode}: ${location}`);

    res.statusCode = statusCode;
    this.setResponseHeaders(res, requestId, { location });

    let body: string;
    const { accept = 'text/plain' } = req.headers;
    if (accept.includes('json')) {
      res.setHeader('content-type', 'application/json');
      const json = JSON.stringify({
        redirect: location,
        status: String(statusCode),
      });
      body = `${json}\n`;
    } else if (accept.includes('html')) {
      res.setHeader('content-type', 'text/html');
      body = redirectTemplate({ location, statusCode });
    } else {
      res.setHeader('content-type', 'text/plain');
      body = `Redirecting to ${location} (${statusCode})\n`;
    }
    res.end(body);
  }

  getRequestIp(req: http.IncomingMessage): string {
    // TODO: respect the `x-forwarded-for` headers
    return req.connection.remoteAddress || '127.0.0.1';
  }

  /**
   * Sets the response `headers` including the platform headers to `res`.
   */
  setResponseHeaders(
    res: http.ServerResponse,
    requestId: string,
    headers: http.OutgoingHttpHeaders = {}
  ): void {
    const allHeaders = {
      'cache-control': 'public, max-age=0, must-revalidate',
      ...headers,
      server: 'Vercel',
      'x-vercel-id': requestId,
      'x-vercel-cache': 'MISS',
    };
    for (const [name, value] of Object.entries(allHeaders)) {
      res.setHeader(name, value);
    }
  }

  /**
   * Returns the request `headers` that will be sent to the Lambda.
   */
  getProxyHeaders(
    req: http.IncomingMessage,
    requestId: string,
    xfwd: boolean
  ): http.IncomingHttpHeaders {
    const ip = this.getRequestIp(req);
    const { host } = req.headers;
    const headers: http.IncomingHttpHeaders = {
      connection: 'close',
      'x-real-ip': ip,
      'x-vercel-deployment-url': host,
      'x-vercel-forwarded-for': ip,
      'x-vercel-id': requestId,
    };
    if (xfwd) {
      headers['x-forwarded-host'] = host;
      headers['x-forwarded-proto'] = 'http';
      headers['x-forwarded-for'] = ip;
    }
    return headers;
  }

  async triggerBuild(
    match: BuildMatch,
    requestPath: string | null,
    req: http.IncomingMessage | null,
    vercelConfig: VercelConfig,
    previousBuildResult?: BuildResult,
    filesChanged?: string[],
    filesRemoved?: string[]
  ) {
    // If the requested asset wasn't found in the match's
    // outputs then trigger a build
    const buildKey =
      requestPath === null
        ? match.entrypoint
        : `${match.entrypoint}-${requestPath}`;
    let buildPromise = this.inProgressBuilds.get(buildKey);
    if (buildPromise) {
      // A build for `buildKey` is already in progress, so don't trigger
      // another rebuild for this request - just wait on the existing one.
      let msg = `De-duping build "${buildKey}"`;
      if (req) {
        msg += ` for "${req.method} ${req.url}"`;
      }
      this.output.debug(msg);
    } else {
      if (previousBuildResult) {
        // Tear down any `output` assets from a previous build, so that they
        // are not available to be served while the rebuild is in progress.
        for (const [name] of Object.entries(previousBuildResult.output)) {
          this.output.debug(`Removing asset "${name}"`);
          delete match.buildOutput[name];
          // TODO: shut down Lambda instance
        }
      }
      let msg = `Building asset "${buildKey}"`;
      if (req) {
        msg += ` for "${req.method} ${req.url}"`;
      }
      this.output.debug(msg);
      buildPromise = executeBuild(
        vercelConfig,
        this,
        this.files,
        match,
        requestPath,
        false,
        filesChanged,
        filesRemoved
      );
      this.inProgressBuilds.set(buildKey, buildPromise);
    }
    try {
      await buildPromise;
    } finally {
      this.output.debug(`Built asset ${buildKey}`);
      this.inProgressBuilds.delete(buildKey);
    }
  }

  getExtensionlessFile = (path: string) => {
    const ext = extname(path);
    if (
      this.apiDir &&
      path.startsWith(this.apiDir + '/') &&
      this.apiExtensions.has(ext)
    ) {
      // lambda function files are trimmed of their file extension
      return path.slice(0, -ext.length);
    }
    return null;
  };

  /**
   * DevServer HTTP handler
   */
  devServerHandler: HttpHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    await this.startPromise;

    let requestId = generateRequestId(this.podId);

    if (this.stopping) {
      res.setHeader('Connection', 'close');
      await this.send404(req, res, requestId);
      return;
    }

    const method = req.method || 'GET';
    this.output.debug(`${chalk.bold(method)} ${req.url}`);

    try {
      const vercelConfig = await this.getVercelConfig();
      await this.serveProjectAsNowV2(req, res, requestId, vercelConfig);
    } catch (err) {
      console.error(err);
      this.output.debug(err.stack);

      if (!res.finished) {
        res.statusCode = 500;
        res.end(err.message);
      }
    }
  };

  /**
   * This is the equivalent to now-proxy exit_with_status() function.
   */
  exitWithStatus = async (
    match: BuildMatch | null,
    routeResult: RouteResult,
    phase: HandleValue | null,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestId: string
  ): Promise<boolean> => {
    const { status, headers, dest } = routeResult;
    const location = headers['location'] || dest;

    if (status && location && 300 <= status && status <= 399) {
      this.output.debug(`Route found with redirect status code ${status}`);
      await this.sendRedirect(req, res, requestId, location, status);
      return true;
    }

    if (!match && status && phase !== 'miss') {
      this.output.debug(`Route found with with status code ${status}`);
      await this.sendError(req, res, requestId, '', status, headers);
      return true;
    }

    return false;
  };

  /**
   * Serve project directory as a v2 deployment.
   */
  serveProjectAsNowV2 = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestId: string,
    vercelConfig: VercelConfig,
    routes: Route[] | undefined = vercelConfig.routes,
    callLevel: number = 0
  ) => {
    const { debug } = this.output;

    // If there is a double-slash present in the URL,
    // then perform a redirect to make it "clean".
    const parsed = url.parse(req.url || '/');
    if (typeof parsed.pathname === 'string' && parsed.pathname.includes('//')) {
      let location = parsed.pathname.replace(/\/+/g, '/');
      if (parsed.search) {
        location += parsed.search;
      }

      // Only `GET` requests are redirected.
      // Other methods are normalized without redirecting.
      if (req.method === 'GET') {
        await this.sendRedirect(req, res, requestId, location, 301);
        return;
      }

      debug(`Rewriting URL from "${req.url}" to "${location}"`);
      req.url = location;
    }

    if (callLevel === 0) {
      await this.updateBuildMatches(vercelConfig);
    }

    if (this.blockingBuildsPromise) {
      debug('Waiting for builds to complete before handling request');
      await this.blockingBuildsPromise;
    }

    const getReqUrl = (rr: RouteResult): string | undefined => {
      if (rr.dest) {
        if (rr.uri_args) {
          const destParsed = url.parse(rr.dest, true);
          Object.assign(destParsed.query, rr.uri_args);
          return url.format(destParsed);
        }
        return rr.dest;
      }
      return req.url;
    };

    const handleMap = getRoutesTypes(routes);
    const missRoutes = handleMap.get('miss') || [];
    const hitRoutes = handleMap.get('hit') || [];
    const errorRoutes = handleMap.get('error') || [];
    const filesystemRoutes = handleMap.get('filesystem') || [];
    const phases: (HandleValue | null)[] = [null, 'filesystem'];

    let routeResult: RouteResult | null = null;
    let match: BuildMatch | null = null;
    let statusCode: number | undefined;
    let prevUrl = req.url;
    let prevHeaders: HttpHeadersConfig = {};

    for (const phase of phases) {
      statusCode = undefined;

      const phaseRoutes = handleMap.get(phase) || [];
      routeResult = await devRouter(
        prevUrl,
        req.method,
        phaseRoutes,
        this,
        vercelConfig,
        prevHeaders,
        missRoutes,
        phase
      );
      prevUrl =
        routeResult.continue && routeResult.dest
          ? getReqUrl(routeResult)
          : req.url;
      prevHeaders =
        routeResult.continue && routeResult.headers ? routeResult.headers : {};

      if (routeResult.isDestUrl) {
        // Mix the `routes` result dest query params into the req path
        const destParsed = url.parse(routeResult.dest, true);
        delete destParsed.search;
        Object.assign(destParsed.query, routeResult.uri_args);
        const destUrl = url.format(destParsed);

        debug(`ProxyPass: ${destUrl}`);
        this.setResponseHeaders(res, requestId);
        return proxyPass(req, res, destUrl, this, requestId);
      }

      match = await findBuildMatch(
        this.buildMatches,
        this.files,
        routeResult.dest,
        this,
        vercelConfig
      );

      if (
        await this.exitWithStatus(
          match,
          routeResult,
          phase,
          req,
          res,
          requestId
        )
      ) {
        return;
      }

      if (!match && missRoutes.length > 0) {
        // Since there was no build match, enter the miss phase
        routeResult = await devRouter(
          getReqUrl(routeResult),
          req.method,
          missRoutes,
          this,
          vercelConfig,
          routeResult.headers,
          [],
          'miss'
        );

        match = await findBuildMatch(
          this.buildMatches,
          this.files,
          routeResult.dest,
          this,
          vercelConfig
        );
        if (
          await this.exitWithStatus(
            match,
            routeResult,
            phase,
            req,
            res,
            requestId
          )
        ) {
          return;
        }
      } else if (match && hitRoutes.length > 0) {
        // Since there was a build match, enter the hit phase.
        // The hit phase must not set status code.
        const prevStatus = routeResult.status;
        routeResult = await devRouter(
          getReqUrl(routeResult),
          req.method,
          hitRoutes,
          this,
          vercelConfig,
          routeResult.headers,
          [],
          'hit'
        );
        routeResult.status = prevStatus;
      }

      statusCode = routeResult.status;

      if (match) {
        // end the phase
        break;
      }

      if (phase === null && filesystemRoutes.length === 0) {
        // hack to skip the reset from null to filesystem
        break;
      }
    }

    if (!match && routeResult && errorRoutes.length > 0) {
      // error phase
      const routeResultForError = await devRouter(
        getReqUrl(routeResult),
        req.method,
        errorRoutes,
        this,
        vercelConfig,
        routeResult.headers,
        [],
        'error'
      );
      const { matched_route } = routeResultForError;

      const matchForError = await findBuildMatch(
        this.buildMatches,
        this.files,
        routeResultForError.dest,
        this,
        vercelConfig
      );

      if (matchForError) {
        debug(`Route match detected in error phase, breaking loop`);
        routeResult = routeResultForError;
        statusCode = routeResultForError.status;
        match = matchForError;
      } else if (matched_route && matched_route.src && !matched_route.dest) {
        debug(
          'Route without `dest` detected in error phase, attempting to exit early'
        );
        if (
          await this.exitWithStatus(
            matchForError,
            routeResultForError,
            'error',
            req,
            res,
            requestId
          )
        ) {
          return;
        }
      }
    }

    if (!routeResult) {
      throw new Error('Expected Route Result but none was found.');
    }

    const { dest, headers, uri_args } = routeResult;

    // Set any headers defined in the matched `route` config
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }

    if (statusCode) {
      // Set the `statusCode` as read-only so that `http-proxy`
      // is not able to modify the value in the future
      Object.defineProperty(res, 'statusCode', {
        get() {
          return statusCode;
        },
        /* eslint-disable @typescript-eslint/no-unused-vars */
        set(_: number) {
          /* ignore */
        },
      });
    }

    const requestPath = dest.replace(/^\//, '');

    if (!match) {
      // If the dev command is started, then proxy to it
      if (this.devProcessPort) {
        const upstream = `http://localhost:${this.devProcessPort}`;
        debug(`Proxying to frontend dev server: ${upstream}`);

        // Add the Vercel platform proxy request headers
        const headers = this.getProxyHeaders(req, requestId, false);
        for (const [name, value] of Object.entries(headers)) {
          req.headers[name] = value;
        }

        this.setResponseHeaders(res, requestId);
        const origUrl = url.parse(req.url || '/', true);
        delete origUrl.search;
        origUrl.pathname = dest;
        Object.assign(origUrl.query, uri_args);
        req.url = url.format(origUrl);
        return proxyPass(req, res, upstream, this, requestId, false);
      }

      if (
        (statusCode === 404 && routeResult.phase === 'miss') ||
        !this.renderDirectoryListing(req, res, requestPath, requestId)
      ) {
        await this.send404(req, res, requestId);
      }
      return;
    }

    const buildRequestPath = match.buildResults.has(null) ? null : requestPath;
    const buildResult = match.buildResults.get(buildRequestPath);

    if (
      buildResult &&
      Array.isArray(buildResult.routes) &&
      buildResult.routes.length > 0
    ) {
      const origUrl = url.parse(req.url || '/', true);
      delete origUrl.search;
      origUrl.pathname = dest;
      Object.assign(origUrl.query, uri_args);
      const newUrl = url.format(origUrl);
      debug(
        `Checking build result's ${buildResult.routes.length} \`routes\` to match ${newUrl}`
      );
      const matchedRoute = await devRouter(
        newUrl,
        req.method,
        buildResult.routes,
        this,
        vercelConfig
      );
      if (matchedRoute.found && callLevel === 0) {
        debug(`Found matching route ${matchedRoute.dest} for ${newUrl}`);
        req.url = newUrl;
        await this.serveProjectAsNowV2(
          req,
          res,
          requestId,
          vercelConfig,
          buildResult.routes,
          callLevel + 1
        );
        return;
      }
    }

    // Before doing any asset matching, check if this builder supports the
    // `startDevServer()` "optimization". In this case, the vercel dev server
    // invokes `startDevServer()` on the builder for the first HTTP request
    // so that it boots up a dev HTTP server that `vercel dev` will proxy
    // this HTTP request to. The dev server process is then reused for subsequent
    // HTTP requests. Once *any* file modification happens, the process is shut down.
    const { builder, package: builderPkg } = match.builderWithPkg;
    if (
      typeof match.devServerResultPromise === 'undefined' &&
      typeof builder.startDevServer === 'function'
    ) {
      try {
        const { envConfigs, files, devCacheDir, cwd: workPath } = this;
        debug(
          `Invoking "startDevServer()" of ${builderPkg.name} for "${match.entrypoint}`
        );
        match.devServerResultPromise = builder.startDevServer({
          files,
          entrypoint: match.entrypoint,
          workPath,
          config: match.config || {},
          meta: {
            isDev: true,
            requestPath,
            devCacheDir,
            env: { ...envConfigs.runEnv },
            buildEnv: { ...envConfigs.buildEnv },
          },
        });
      } catch (err) {
        // `startDevServer()` threw an error. Most likely this means the dev
        // server process exited before sending the port information message
        // (missing dependency at runtime, for example).
        if (err.code === 'ENOENT') {
          err.message = `Command not found: ${chalk.cyan(
            err.path,
            ...err.spawnargs
          )}\nPlease ensure that ${cmd(err.path)} is properly installed`;
          err.link = 'https://vercel.link/command-not-found';
        }

        this.output.prettyError(err);

        await this.sendError(
          req,
          res,
          requestId,
          'NO_RESPONSE_FROM_FUNCTION',
          502
        );
        return;
      }
    }

    const devServerResult = await match.devServerResultPromise;
    if (devServerResult) {
      // When invoking lambda functions, the region where the lambda was invoked
      // is also included in the request ID. So use the same `dev1` fake region.
      requestId = generateRequestId(this.podId, true);

      const { port, pid } = devServerResult;
      this.devServerPids.add(pid);

      debug(
        `Proxying to "${builderPkg.name}" dev server (port=${port}, pid=${pid})`
      );

      // Mix in the routing based query parameters
      const parsed = url.parse(req.url || '/', true);
      Object.assign(parsed.query, uri_args);
      req.url = url.format({
        pathname: parsed.pathname,
        query: parsed.query,
      });

      // Add the Vercel platform proxy request headers
      const headers = this.getProxyHeaders(req, requestId, false);
      for (const [name, value] of Object.entries(headers)) {
        req.headers[name] = value;
      }

      this.setResponseHeaders(res, requestId);
      return proxyPass(
        req,
        res,
        `http://localhost:${port}`,
        this,
        requestId,
        false
      );
    } else if (devServerResult === null) {
      debug(`Skipping \`startDevServer()\` for ${match.entrypoint}`);
    }

    let foundAsset = findAsset(match, requestPath, vercelConfig);
    if (!foundAsset && callLevel === 0) {
      await this.triggerBuild(match, buildRequestPath, req, vercelConfig);

      // Since the `asset` was just built, resolve again to get the new asset
      foundAsset = findAsset(match, requestPath, vercelConfig);
    }

    // Proxy to the dev server:
    // - when there is no asset
    // - when the asset is not a Lambda (the dev server must take care of all static files)
    if (
      this.devProcessPort &&
      (!foundAsset || (foundAsset && foundAsset.asset.type !== 'Lambda'))
    ) {
      debug('Proxying to frontend dev server');

      // Add the Vercel platform proxy request headers
      const headers = this.getProxyHeaders(req, requestId, false);
      for (const [name, value] of Object.entries(headers)) {
        req.headers[name] = value;
      }

      this.setResponseHeaders(res, requestId);
      return proxyPass(
        req,
        res,
        `http://localhost:${this.devProcessPort}`,
        this,
        requestId,
        false
      );
    }

    if (!foundAsset) {
      await this.send404(req, res, requestId);
      return;
    }

    const { asset, assetKey } = foundAsset;
    debug(
      `Serving asset: [${asset.type}] ${assetKey} ${
        (asset as any).contentType || ''
      }`
    );

    /* eslint-disable no-case-declarations */
    switch (asset.type) {
      case 'FileFsRef':
        this.setResponseHeaders(res, requestId);
        req.url = `/${basename(asset.fsPath)}`;
        return serveStaticFile(req, res, dirname(asset.fsPath), {
          headers: [
            {
              source: '**/*',
              headers: [
                {
                  key: 'Content-Type',
                  value: asset.contentType || getMimeType(assetKey),
                },
              ],
            },
          ],
        });

      case 'FileBlob':
        const headers: http.OutgoingHttpHeaders = {
          'Content-Length': asset.data.length,
          'Content-Type': asset.contentType || getMimeType(assetKey),
        };
        this.setResponseHeaders(res, requestId, headers);
        res.end(asset.data);
        return;

      case 'Lambda':
        if (!asset.fn) {
          // This is mostly to appease TypeScript since `fn` is an optional prop,
          // but this shouldn't really ever happen since we run the builds before
          // responding to HTTP requests.
          await this.sendError(
            req,
            res,
            requestId,
            'INTERNAL_LAMBDA_NOT_FOUND'
          );
          return;
        }

        // When invoking lambda functions, the region where the lambda was invoked
        // is also included in the request ID. So use the same `dev1` fake region.
        requestId = generateRequestId(this.podId, true);

        // Mix the `routes` result dest query params into the req path
        const parsed = url.parse(req.url || '/', true);
        Object.assign(parsed.query, uri_args);
        const path = url.format({
          pathname: parsed.pathname,
          query: parsed.query,
        });

        const body = await rawBody(req);
        const payload: InvokePayload = {
          method: req.method || 'GET',
          host: req.headers.host,
          path,
          headers: {
            ...req.headers,
            ...this.getProxyHeaders(req, requestId, true),
          },
          encoding: 'base64',
          body: body.toString('base64'),
        };

        debug(`Invoking lambda: "${assetKey}" with ${path}`);

        let result: InvokeResult;
        try {
          result = await asset.fn<InvokeResult>({
            Action: 'Invoke',
            body: JSON.stringify(payload),
          });
        } catch (err) {
          console.error(err);
          await this.sendError(
            req,
            res,
            requestId,
            'NO_RESPONSE_FROM_FUNCTION',
            502
          );
          return;
        }

        if (!statusCode) {
          res.statusCode = result.statusCode;
        }
        this.setResponseHeaders(res, requestId, result.headers);

        let resBody: Buffer | string | undefined;
        if (result.encoding === 'base64' && typeof result.body === 'string') {
          resBody = Buffer.from(result.body, 'base64');
        } else {
          resBody = result.body;
        }
        return res.end(resBody);

      default:
        // This shouldn't really ever happen...
        await this.sendError(req, res, requestId, 'UNKNOWN_ASSET_TYPE');
    }
  };

  renderDirectoryListing(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    requestPath: string,
    requestId: string
  ): boolean {
    // If the "directory listing" feature is disabled in the
    // Project's settings, then don't render the directory listing
    if (this.projectSettings?.directoryListing === false) {
      return false;
    }

    let prefix = requestPath;
    if (prefix.length > 0 && !prefix.endsWith('/')) {
      prefix += '/';
    }

    const dirs: Set<string> = new Set();
    const files = Array.from(this.buildMatches.keys())
      .filter(p => {
        const base = basename(p);
        if (
          base === 'now.json' ||
          base === 'vercel.json' ||
          base === '.nowignore' ||
          base === '.vercelignore' ||
          !p.startsWith(prefix)
        ) {
          return false;
        }
        const rel = relative(prefix, p);
        if (rel.includes('/')) {
          const dir = rel.split('/')[0];
          if (dirs.has(dir)) {
            return false;
          }
          dirs.add(dir);
        }
        return true;
      })
      .map(p => {
        let base = basename(p);
        let ext = '';
        let type = 'file';
        let href: string;

        const rel = relative(prefix, p);
        if (rel.includes('/')) {
          // Directory
          type = 'folder';
          base = rel.split('/')[0];
          href = `/${prefix}${base}/`;
        } else {
          // File / Lambda
          ext = extname(p).substring(1);
          href = `/${prefix}${base}`;
        }
        return {
          type,
          relative: href,
          ext,
          title: href,
          base,
        };
      });

    if (files.length === 0) {
      return false;
    }

    const directory = `/${prefix}`;
    const paths = [
      {
        name: directory,
        url: requestPath,
      },
    ];
    const directoryHtml = directoryTemplate({
      files,
      paths,
      directory,
    });
    this.setResponseHeaders(res, requestId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Length',
      String(Buffer.byteLength(directoryHtml, 'utf8'))
    );
    res.end(directoryHtml);
    return true;
  }

  async hasFilesystem(
    dest: string,
    vercelConfig: VercelConfig
  ): Promise<boolean> {
    if (
      await findBuildMatch(
        this.buildMatches,
        this.files,
        dest,
        this,
        vercelConfig,
        true
      )
    ) {
      return true;
    }
    return false;
  }

  isCaseSensitive(): boolean {
    return this.caseSensitive;
  }

  async runDevCommand() {
    const { devCommand, cwd } = this;

    if (!devCommand) {
      return;
    }

    this.output.log(
      `Running Dev Command ${chalk.cyan.bold(`“${devCommand}”`)}`
    );

    const port = await getPort();

    const env: Env = {
      // Because of child process 'pipe' below, isTTY will be false.
      // Most frameworks use `chalk`/`supports-color` so we enable it anyway.
      FORCE_COLOR: process.stdout.isTTY ? '1' : '0',
      ...(this.frameworkSlug === 'create-react-app' ? { BROWSER: 'none' } : {}),
      ...process.env,
      ...this.envConfigs.allEnv,
      PORT: `${port}`,
    };

    // This is necesary so that the dev command in the Project
    // will work cross-platform (especially Windows).
    let command = devCommand
      .replace(/\$PORT/g, `${port}`)
      .replace(/%PORT%/g, `${port}`);

    this.output.debug(
      `Starting dev command with parameters : ${JSON.stringify({
        cwd,
        command,
        port,
      })}`
    );

    const isNpxAvailable = await which('npx')
      .then(() => true)
      .catch(() => false);

    if (isNpxAvailable) {
      command = `npx --no-install ${command}`;
    } else {
      const isYarnAvailable = await which('yarn')
        .then(() => true)
        .catch(() => false);

      if (isYarnAvailable) {
        command = `yarn run --silent ${command}`;
      }
    }

    this.output.debug(`Spawning dev command: ${command}`);

    const devPort = new URL(this.address).port;
    const proxyPort = new RegExp(port.toString(), 'g');
    const p = spawnCommand(command, {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd,
      env,
    });

    if (!p.stdout || !p.stderr) {
      throw new Error('Expected child process to have stdout and stderr');
    }

    p.stderr.pipe(process.stderr);
    p.stdout.setEncoding('utf8');

    p.stdout.on('data', (data: string) => {
      process.stdout.write(data.replace(proxyPort, devPort));
    });

    p.on('exit', () => {
      this.devProcessPort = undefined;
    });

    await checkForPort(port, 1000 * 60 * 5);

    this.devProcessPort = port;
    this.devProcess = p;
  }
}

/**
 * Mimic nginx's `proxy_pass` for routes using a URL as `dest`.
 */
function proxyPass(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dest: string,
  devServer: DevServer,
  requestId: string,
  ignorePath: boolean = true
): void {
  return devServer.proxy.web(
    req,
    res,
    { target: dest, ignorePath },
    (error: NodeJS.ErrnoException) => {
      devServer.output.error(
        `Failed to complete request to ${req.url}: ${error}`
      );
      if (!res.headersSent) {
        devServer.sendError(
          req,
          res,
          requestId,
          'NO_RESPONSE_FROM_FUNCTION',
          502
        );
      }
    }
  );
}

/**
 * Handle requests for static files with serve-handler.
 */
function serveStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  opts?: object
) {
  return serveHandler(req, res, {
    public: cwd,
    cleanUrls: false,
    etag: true,
    ...opts,
  });
}

function close(server: http.Server | httpProxy): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Generates a (fake) tracing ID for an HTTP request.
 *
 * Example: dev1:q4wlg-1562364135397-7a873ac99c8e
 */
function generateRequestId(podId: string, isInvoke = false): string {
  const invoke = isInvoke ? 'dev1::' : '';
  return `dev1::${invoke}${[
    podId,
    Date.now(),
    randomBytes(6).toString('hex'),
  ].join('-')}`;
}

function hasOwnProperty(obj: any, prop: string) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

async function findBuildMatch(
  matches: Map<string, BuildMatch>,
  files: BuilderInputs,
  requestPath: string,
  devServer: DevServer,
  vercelConfig: VercelConfig,
  isFilesystem = false
): Promise<BuildMatch | null> {
  requestPath = requestPath.replace(/^\//, '');

  let bestIndexMatch: undefined | BuildMatch;
  for (const match of matches.values()) {
    if (
      await shouldServe(
        match,
        files,
        requestPath,
        devServer,
        vercelConfig,
        isFilesystem
      )
    ) {
      if (!isIndex(match.src)) {
        return match;
      } else {
        // if isIndex === true and ends in .html, we're done. Otherwise, keep searching
        bestIndexMatch = match;
        if (extname(match.src) === '.html') {
          return bestIndexMatch;
        }
      }
    }
  }

  // return a non-.html index file or none are found
  return bestIndexMatch || null;
}

async function shouldServe(
  match: BuildMatch,
  files: BuilderInputs,
  requestPath: string,
  devServer: DevServer,
  vercelConfig: VercelConfig,
  isFilesystem = false
): Promise<boolean> {
  const {
    src,
    config,
    builderWithPkg: { builder },
  } = match;
  const cleanSrc = src.endsWith('.html') ? src.slice(0, -5) : src;
  const trimmedPath = requestPath.endsWith('/')
    ? requestPath.slice(0, -1)
    : requestPath;

  if (
    vercelConfig.cleanUrls &&
    vercelConfig.trailingSlash &&
    cleanSrc === trimmedPath
  ) {
    // Mimic fmeta-util and convert cleanUrls and trailingSlash
    return true;
  } else if (
    vercelConfig.cleanUrls &&
    !vercelConfig.trailingSlash &&
    cleanSrc === requestPath
  ) {
    // Mimic fmeta-util and convert cleanUrls
    return true;
  } else if (
    !vercelConfig.cleanUrls &&
    vercelConfig.trailingSlash &&
    src === trimmedPath
  ) {
    // Mimic fmeta-util and convert trailingSlash
    return true;
  } else if (typeof builder.shouldServe === 'function') {
    const shouldServe = await builder.shouldServe({
      entrypoint: src,
      files,
      config: config || {},
      requestPath,
      workPath: devServer.cwd,
    });
    if (shouldServe) {
      return true;
    }
  } else if (findAsset(match, requestPath, vercelConfig)) {
    // If there's no `shouldServe()` function, then look up if there's
    // a matching build asset on the `match` that has already been built.
    return true;
  } else if (
    !isFilesystem &&
    (await findMatchingRoute(match, requestPath, devServer, vercelConfig))
  ) {
    // If there's no `shouldServe()` function and no matched asset, then look
    // up if there's a matching build route on the `match` that has already
    // been built.
    return true;
  }
  return false;
}

async function findMatchingRoute(
  match: BuildMatch,
  requestPath: string,
  devServer: DevServer,
  vercelConfig: VercelConfig
): Promise<RouteResult | void> {
  const reqUrl = `/${requestPath}`;
  for (const buildResult of match.buildResults.values()) {
    if (!Array.isArray(buildResult.routes)) continue;
    const route = await devRouter(
      reqUrl,
      undefined,
      buildResult.routes,
      devServer,
      vercelConfig
    );
    if (route.found) {
      return route;
    }
  }
}

function findAsset(
  match: BuildMatch,
  requestPath: string,
  vercelConfig: VercelConfig
): { asset: BuilderOutput; assetKey: string } | void {
  if (!match.buildOutput) {
    return;
  }
  let assetKey: string = requestPath.replace(/\/$/, '');
  let asset = match.buildOutput[requestPath];

  if (vercelConfig.trailingSlash && requestPath.endsWith('/')) {
    asset = match.buildOutput[requestPath.slice(0, -1)];
  }

  // In the case of an index path, fall back to iterating over the
  // builder outputs and doing an "is index" check until a match is found.
  if (!asset) {
    for (const [name, a] of Object.entries(match.buildOutput)) {
      if (isIndex(name) && dirnameWithoutDot(name) === assetKey) {
        asset = a;
        assetKey = name;
        break;
      }
    }
  }

  if (asset) {
    return { asset, assetKey };
  }
}

function dirnameWithoutDot(path: string): string {
  let dir = dirname(path);
  if (dir === '.') {
    dir = '';
  }
  return dir;
}

function isIndex(path: string): boolean {
  const ext = extname(path);
  const name = basename(path, ext);
  return name === 'index';
}

function minimatches(files: string[], pattern: string): boolean {
  return files.some(
    file => file === pattern || minimatch(file, pattern, { dot: true })
  );
}

function fileChanged(
  name: string,
  changed: Set<string>,
  removed: Set<string>
): void {
  changed.add(name);
  removed.delete(name);
}

function fileRemoved(
  name: string,
  files: BuilderInputs,
  changed: Set<string>,
  removed: Set<string>
): void {
  delete files[name];
  changed.delete(name);
  removed.add(name);
}

function needsBlockingBuild(buildMatch: BuildMatch): boolean {
  const { builder } = buildMatch.builderWithPkg;
  return typeof builder.shouldServe !== 'function';
}

async function checkForPort(
  port: number | undefined,
  timeout: number
): Promise<void> {
  const start = Date.now();
  while (!(await isPortReachable(port))) {
    if (Date.now() - start > timeout) {
      throw new Error(`Detecting port ${port} timed out after ${timeout}ms`);
    }
    await sleep(100);
  }
}

function filterFrontendBuilds(build: Builder) {
  const { name } = npa(build.use);
  return !frontendRuntimeSet.has(name || '');
}

function hasNewRoutingProperties(vercelConfig: VercelConfig) {
  return (
    typeof vercelConfig.cleanUrls !== undefined ||
    typeof vercelConfig.headers !== undefined ||
    typeof vercelConfig.redirects !== undefined ||
    typeof vercelConfig.rewrites !== undefined ||
    typeof vercelConfig.trailingSlash !== undefined
  );
}

function buildMatchEquals(a?: BuildMatch, b?: BuildMatch): boolean {
  if (!a || !b) return false;
  if (a.src !== b.src) return false;
  if (a.use !== b.use) return false;
  if (!deepEqual(a.config || {}, b.config || {})) return false;
  return true;
}
