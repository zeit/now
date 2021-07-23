/* disable this rule _here_ to avoid conflict with ongoing changes */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import ms from 'ms';
import bytes from 'bytes';
import { delimiter, dirname, join } from 'path';
import { fork, ChildProcess } from 'child_process';
import { createFunction } from '@zeit/fun';
import {
  Builder,
  BuildOptions,
  Env,
  File,
  Lambda,
  FileBlob,
  FileFsRef,
  isOfficialRuntime,
} from '@vercel/build-utils';
import plural from 'pluralize';
import minimatch from 'minimatch';

import { Output } from '../output';
import highlight from '../output/highlight';
import { treeKill } from '../tree-kill';
import { relative } from '../path-helpers';
import { LambdaSizeExceededError } from '../errors-ts';

import DevServer from './server';
import { getBuilder } from './builder-cache';
import {
  VercelConfig,
  BuildMatch,
  BuildResult,
  BuilderInputs,
  BuilderOutput,
  BuildResultV3,
  BuilderOutputs,
  EnvConfigs,
} from './types';
import { normalizeRoutes } from '@vercel/routing-utils';
import getUpdateCommand from '../get-update-command';
import { getTitleName } from '../pkg-name';

interface BuildMessage {
  type: string;
}

interface BuildMessageResult extends BuildMessage {
  type: 'buildResult';
  result?: BuilderOutputs | BuildResult;
  error?: object;
}

async function createBuildProcess(
  match: BuildMatch,
  envConfigs: EnvConfigs,
  workPath: string,
  output: Output
): Promise<ChildProcess> {
  output.debug(`Creating build process for "${match.entrypoint}"`);

  const builderWorkerPath = join(__dirname, 'builder-worker.js');

  // Ensure that `node` is in the builder's `PATH`
  let PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`;

  const env: Env = {
    ...process.env,
    PATH,
    ...envConfigs.allEnv,
  };

  const buildProcess = fork(builderWorkerPath, [], {
    cwd: workPath,
    execArgv: [],
    env,
  });
  match.buildProcess = buildProcess;

  buildProcess.on('exit', (code, signal) => {
    output.debug(
      `Build process for "${match.entrypoint}" exited with ${signal || code}`
    );
    match.buildProcess = undefined;
  });

  return new Promise((resolve, reject) => {
    // The first message that the builder process sends is the `ready` event
    buildProcess.once('message', ({ type }) => {
      if (type !== 'ready') {
        reject(new Error('Did not get "ready" event from builder'));
      } else {
        resolve(buildProcess);
      }
    });
  });
}

export async function executeBuild(
  vercelConfig: VercelConfig,
  devServer: DevServer,
  files: BuilderInputs,
  match: BuildMatch,
  requestPath: string | null,
  isInitialBuild: boolean,
  filesChanged?: string[],
  filesRemoved?: string[]
): Promise<void> {
  const {
    builderWithPkg: { runInProcess, requirePath, builder, package: pkg },
  } = match;
  const { entrypoint } = match;
  const { debug, envConfigs, cwd: workPath, devCacheDir } = devServer;

  const startTime = Date.now();
  const showBuildTimestamp =
    !isOfficialRuntime('static', match.use) && (!isInitialBuild || debug);

  if (showBuildTimestamp) {
    devServer.output.log(`Building ${match.use}:${entrypoint}`);
    devServer.output.debug(
      `Using \`${pkg.name}${pkg.version ? `@${pkg.version}` : ''}\``
    );
  }

  const config = match.config || {};

  let result: BuildResult;

  let { buildProcess } = match;
  if (!runInProcess && !buildProcess) {
    buildProcess = await createBuildProcess(
      match,
      envConfigs,
      workPath,
      devServer.output
    );
  }

  const buildOptions: BuildOptions = {
    files,
    entrypoint,
    workPath,
    config,
    meta: {
      isDev: true,
      requestPath,
      devCacheDir,
      filesChanged,
      filesRemoved,
      // This env distiniction is only necessary to maintain
      // backwards compatibility with the `@vercel/next` builder.
      env: { ...envConfigs.runEnv },
      buildEnv: { ...envConfigs.buildEnv },
    },
  };

  let buildResultOrOutputs: BuilderOutputs | BuildResult | BuildResultV3;
  if (buildProcess) {
    buildProcess.send({
      type: 'build',
      requirePath,
      buildOptions,
    });

    buildResultOrOutputs = await new Promise((resolve, reject) => {
      function onMessage({ type, result, error }: BuildMessageResult) {
        cleanup();
        if (type === 'buildResult') {
          if (result) {
            resolve(result);
          } else if (error) {
            reject(Object.assign(new Error(), error));
          }
        } else {
          reject(new Error(`Got unexpected message type: ${type}`));
        }
      }
      function onExit(code: number | null, signal: string | null) {
        cleanup();
        const err = new Error(
          `Builder exited with ${signal || code} before sending build result`
        );
        reject(err);
      }
      function cleanup() {
        buildProcess!.removeListener('exit', onExit);
        buildProcess!.removeListener('message', onMessage);
      }
      buildProcess!.on('exit', onExit);
      buildProcess!.on('message', onMessage);
    });
  } else {
    buildResultOrOutputs = await builder.build(buildOptions);
  }

  // Sort out build result to builder v2 shape
  if (!builder.version || builder.version === 1) {
    // `BuilderOutputs` map was returned (Now Builder v1 behavior)
    result = {
      output: buildResultOrOutputs as BuilderOutputs,
      routes: [],
      watch: [],
      distPath:
        typeof buildResultOrOutputs.distPath === 'string'
          ? buildResultOrOutputs.distPath
          : undefined,
    };
  } else if (builder.version === 2) {
    result = buildResultOrOutputs as BuildResult;
  } else if (builder.version === 3) {
    const { output, ...rest } = buildResultOrOutputs as BuildResultV3;

    if (!output || (output as BuilderOutput).type !== 'Lambda') {
      throw new Error('The result of "builder.build()" must be a `Lambda`');
    }

    if (output.maxDuration) {
      throw new Error(
        'The result of "builder.build()" must not contain `memory`'
      );
    }

    if (output.memory) {
      throw new Error(
        'The result of "builder.build()" must not contain `maxDuration`'
      );
    }

    for (const [src, func] of Object.entries(config.functions || {})) {
      if (src === entrypoint || minimatch(entrypoint, src)) {
        if (func.maxDuration) {
          output.maxDuration = func.maxDuration;
        }

        if (func.memory) {
          output.memory = func.memory;
        }

        break;
      }
    }

    result = {
      ...rest,
      output: {
        [entrypoint]: output,
      },
    } as BuildResult;
  } else {
    throw new Error(
      `${getTitleName()} CLI does not support builder version ${
        builder.version
      }.\nPlease run \`${await getUpdateCommand()}\` to update to the latest CLI.`
    );
  }

  // Normalize Builder Routes
  const normalized = normalizeRoutes(result.routes);
  if (normalized.error) {
    throw new Error(normalized.error.message);
  } else {
    result.routes = normalized.routes || [];
  }

  const { output } = result;
  const { cleanUrls } = vercelConfig;

  // Mimic fmeta-util and perform file renaming
  Object.entries(output).forEach(([path, value]) => {
    if (cleanUrls && path.endsWith('.html')) {
      path = path.slice(0, -5);

      if (value.type === 'FileBlob' || value.type === 'FileFsRef') {
        value.contentType = value.contentType || 'text/html; charset=utf-8';
      }
    }

    const extensionless = devServer.getExtensionlessFile(path);
    if (extensionless) {
      path = extensionless;
    }

    output[path] = value;
  });

  // Convert the JSON-ified output map back into their corresponding `File`
  // subclass type instances.
  for (const name of Object.keys(output)) {
    const obj = output[name] as File;
    let lambda: Lambda;
    let fileRef: FileFsRef;
    let fileBlob: FileBlob;
    switch (obj.type) {
      case 'FileFsRef':
        fileRef = Object.assign(Object.create(FileFsRef.prototype), obj);
        output[name] = fileRef;
        break;
      case 'FileBlob':
        fileBlob = Object.assign(Object.create(FileBlob.prototype), obj);
        fileBlob.data = Buffer.from((obj as any).data.data);
        output[name] = fileBlob;
        break;
      case 'Lambda':
        lambda = Object.assign(Object.create(Lambda.prototype), obj) as Lambda;
        // Convert the JSON-ified Buffer object back into an actual Buffer
        lambda.zipBuffer = Buffer.from((obj as any).zipBuffer.data);
        output[name] = lambda;
        break;
      default:
        throw new Error(`Unknown file type: ${obj.type}`);
    }
  }

  // The `watch` array must not have "./" prefix, so if the builder returned
  // watched files that contain "./" strip them here for ease of writing the
  // builder.
  result.watch = (result.watch || []).map((w: string) => {
    if (w.startsWith('./')) {
      return w.substring(2);
    }
    return w;
  });

  // The `entrypoint` should always be watched, since we know that it was used
  // to produce the build output. This is for builders that don't implement
  // a fully featured `watch` return value.
  if (!result.watch.includes(entrypoint)) {
    result.watch.push(entrypoint);
  }

  // Enforce the lambda zip size soft watermark
  const maxLambdaBytes = bytes('50mb');
  for (const asset of Object.values(result.output)) {
    if (asset.type === 'Lambda') {
      const size = asset.zipBuffer.length;
      if (size > maxLambdaBytes) {
        throw new LambdaSizeExceededError(size, maxLambdaBytes);
      }
    }
  }

  // Create function for all 'Lambda' type output
  await Promise.all(
    Object.entries(result.output).map(async entry => {
      const path: string = entry[0];
      const asset: BuilderOutput = entry[1];

      if (asset.type === 'Lambda') {
        // Tear down the previous `fun` Lambda instance for this asset
        const oldAsset = match.buildOutput && match.buildOutput[path];
        if (oldAsset && oldAsset.type === 'Lambda' && oldAsset.fn) {
          await oldAsset.fn.destroy();
        }

        asset.fn = await createFunction({
          Code: { ZipFile: asset.zipBuffer },
          Handler: asset.handler,
          Runtime: asset.runtime,
          MemorySize: asset.memory || 3008,
          Environment: {
            Variables: {
              ...vercelConfig.env,
              ...asset.environment,
              ...envConfigs.runEnv,
            },
          },
        });
      }

      match.buildTimestamp = Date.now();
    })
  );

  match.buildResults.set(requestPath, result);
  Object.assign(match.buildOutput, result.output);

  if (showBuildTimestamp) {
    const endTime = Date.now();
    devServer.output.log(
      `Built ${match.use}:${entrypoint} [${ms(endTime - startTime)}]`
    );
  }
}

export async function getBuildMatches(
  vercelConfig: VercelConfig,
  cwd: string,
  output: Output,
  devServer: DevServer,
  fileList: string[]
): Promise<BuildMatch[]> {
  const matches: BuildMatch[] = [];

  if (fileList.length === 0) {
    // If there's no files in the cwd then we know there won't be any build
    // matches, so bail eagerly, and avoid printing the "no matches" message.
    return matches;
  }

  const noMatches: Builder[] = [];
  const builds = vercelConfig.builds || [{ src: '**', use: '@vercel/static' }];

  for (const buildConfig of builds) {
    let { src = '**', use, config = {} } = buildConfig;

    if (!use) {
      continue;
    }

    if (src[0] === '/') {
      // Remove a leading slash so that the globbing is relative to `cwd`
      // instead of the root of the filesystem. This matches the behavior
      // of Vercel deployments.
      src = src.substring(1);
    }

    // We need to escape brackets since `glob` will
    // try to find a group otherwise
    src = src.replace(/(\[|\])/g, '[$1]');

    // lambda function files are trimmed of their file extension
    const mapToEntrypoint = new Map<string, string>();
    const extensionless = devServer.getExtensionlessFile(src);
    if (extensionless) {
      mapToEntrypoint.set(extensionless, src);
      src = extensionless;
    }

    const files = fileList
      .filter(name => name === src || minimatch(name, src, { dot: true }))
      .map(name => join(cwd, name));

    if (files.length === 0) {
      noMatches.push(buildConfig);
    }

    for (const file of files) {
      src = relative(cwd, file);

      // Remove the output directory prefix
      if (config.zeroConfig && config.outputDirectory) {
        const outputMatch = config.outputDirectory + '/';
        if (src.startsWith(outputMatch)) {
          src = src.slice(outputMatch.length);
        }
      }

      const builderWithPkg = await getBuilder(use, output);
      matches.push({
        ...buildConfig,
        src,
        entrypoint: mapToEntrypoint.get(src) || src,
        builderWithPkg,
        buildOutput: {},
        buildResults: new Map(),
        buildTimestamp: 0,
      });
    }
  }

  if (noMatches.length > 0) {
    output.warn(
      `You defined ${plural(
        'build',
        noMatches.length,
        true
      )} that did not match any source files (please ensure they are NOT defined in ${highlight(
        '.vercelignore'
      )}):`
    );
    for (const buildConfig of noMatches) {
      output.print(`- ${JSON.stringify(buildConfig)}\n`);
    }
  }

  return matches;
}

export async function shutdownBuilder(
  match: BuildMatch,
  { debug }: Output
): Promise<void> {
  const ops: Promise<void>[] = [];

  if (match.buildProcess) {
    const { pid } = match.buildProcess;
    debug(`Killing ${match.use} sub-process with PID ${pid}`);
    const killPromise = treeKill(pid)
      .then(() => {
        debug(`Killed builder with PID ${pid}`);
      })
      .catch((err: Error) => {
        debug(`Failed to kill builder with PID ${pid}: ${err}`);
      });
    ops.push(killPromise);
    delete match.buildProcess;
  }

  if (match.buildOutput) {
    for (const asset of Object.values(match.buildOutput)) {
      if (asset.type === 'Lambda' && asset.fn) {
        debug(`Shutting down Lambda function`);
        ops.push(asset.fn.destroy());
      }
    }
  }

  const devServerResult = await match.devServerResultPromise;
  if (devServerResult) {
    const { pid } = devServerResult;
    debug(`Killing ${match.use} dev server process with PID ${pid}`);
    const killPromise = treeKill(pid)
      .then(() => {
        debug(`Killed builder with PID ${pid}`);
      })
      .catch((err: Error) => {
        debug(`Failed to kill builder with PID ${pid}: ${err}`);
      });
    ops.push(killPromise);
    delete match.devServerResultPromise;
  }

  await Promise.all(ops);
}
