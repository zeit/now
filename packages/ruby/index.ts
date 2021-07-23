import { join, dirname } from 'path';
import execa from 'execa';
import {
  ensureDir,
  move,
  remove,
  pathExists,
  readFile,
  writeFile,
} from 'fs-extra';
import { performance } from 'perf_hooks';
import once from '@tootallnate/once';
import { spawn } from 'child_process';
import type {
  BuildOptions,
  StartDevServerOptions,
  StartDevServerResult,
} from '@vercel/build-utils';
import type { Readable } from 'stream';
import buildUtils from './build-utils';
const {
  download,
  getWriteableDirectory,
  glob,
  createLambda,
  debug,
  walkParentDirs,
} = buildUtils;
import { installBundler } from './install-ruby';

async function matchPaths(
  configPatterns: string | string[] | undefined,
  workPath: string
) {
  const patterns =
    typeof configPatterns === 'string' ? [configPatterns] : configPatterns;

  if (!patterns) {
    return [];
  }

  const patternPaths = await Promise.all(
    patterns.map(async pattern => {
      const files = await glob(pattern, workPath);
      return Object.keys(files);
    })
  );

  return patternPaths.reduce((a, b) => a.concat(b), []);
}

async function bundleInstall(
  bundlePath: string,
  bundleDir: string,
  gemfilePath: string
) {
  debug(`running "bundle install --deployment"...`);
  const bundleAppConfig = await getWriteableDirectory();

  try {
    await execa(
      bundlePath,
      [
        'install',
        '--deployment',
        '--gemfile',
        gemfilePath,
        '--path',
        bundleDir,
      ],
      {
        stdio: 'pipe',
        env: {
          BUNDLE_SILENCE_ROOT_WARNING: '1',
          BUNDLE_APP_CONFIG: bundleAppConfig,
          BUNDLE_JOBS: '4',
        },
      }
    );
  } catch (err) {
    debug(`failed to run "bundle install --deployment"...`);
    throw err;
  }
}

export const version = 3;

export async function build({
  workPath,
  files,
  entrypoint,
  config,
  meta = {},
}: BuildOptions) {
  await download(files, workPath, meta);
  const entrypointFsDirname = join(workPath, dirname(entrypoint));
  const gemfilePath = await walkParentDirs({
    base: workPath,
    start: entrypointFsDirname,
    filename: 'Gemfile',
  });
  const gemfileContents = gemfilePath
    ? await readFile(gemfilePath, 'utf8')
    : '';
  const { gemHome, bundlerPath, vendorPath, runtime } = await installBundler(
    meta,
    gemfileContents
  );
  process.env.GEM_HOME = gemHome;
  debug(`Checking existing vendor directory at "${vendorPath}"`);
  const vendorDir = join(workPath, vendorPath);
  const bundleDir = join(workPath, 'vendor', 'bundle');
  const relativeVendorDir = join(entrypointFsDirname, vendorPath);
  const hasRootVendorDir = await pathExists(vendorDir);
  const hasRelativeVendorDir = await pathExists(relativeVendorDir);
  const hasVendorDir = hasRootVendorDir || hasRelativeVendorDir;
  console.log({
    relativeVendorDir,
    hasRootVendorDir,
    hasRelativeVendorDir,
    vendorPath,
  });

  if (hasRelativeVendorDir) {
    if (hasRootVendorDir) {
      debug(
        'found two vendor directories, choosing the vendor directory relative to entrypoint'
      );
    } else {
      debug('found vendor directory relative to entrypoint');
    }

    // vendor dir must be at the root for lambda to find it
    await move(relativeVendorDir, vendorDir);
  } else if (hasRootVendorDir) {
    debug('found vendor directory in project root');
  }

  await ensureDir(vendorDir);

  // no vendor directory, check for Gemfile to install
  if (!hasVendorDir) {
    if (gemfilePath) {
      debug(
        'did not find a vendor directory but found a Gemfile, bundling gems...'
      );

      // try installing. this won't work if native extesions are required.
      // if that's the case, gems should be vendored locally before deploying.
      try {
        await bundleInstall(bundlerPath, bundleDir, gemfilePath);
      } catch (err) {
        debug(
          'unable to build gems from Gemfile. vendor the gems locally with "bundle install --deployment" and retry.'
        );
        throw err;
      }
    }
  } else {
    debug('found vendor directory, skipping "bundle install"...');
  }

  // try to remove gem cache to slim bundle size
  try {
    await remove(join(vendorDir, 'cache'));
  } catch (e) {
    // don't do anything here
  }

  const originalRbPath = join(__dirname, '..', 'vc_init.rb');
  const originalHandlerRbContents = await readFile(originalRbPath, 'utf8');

  // will be used on `require_relative '$here'` or for loading rack config.ru file
  // for example, `require_relative 'api/users'`
  debug('entrypoint is', entrypoint);
  const userHandlerFilePath = entrypoint.replace(/\.rb$/, '');
  const nowHandlerRbContents = originalHandlerRbContents.replace(
    /__VC_HANDLER_FILENAME/g,
    userHandlerFilePath
  );

  // in order to allow the user to have `server.rb`, we need our `server.rb` to be called
  // somethig else
  const handlerRbFilename = 'vc__handler__ruby';

  await writeFile(
    join(workPath, `${handlerRbFilename}.rb`),
    nowHandlerRbContents
  );

  const outputFiles = await glob('**', workPath);

  // static analysis is impossible with ruby.
  // instead, provide `includeFiles` and `excludeFiles` config options to reduce bundle size.
  if (config && (config.includeFiles || config.excludeFiles)) {
    const includedPaths = await matchPaths(config.includeFiles, workPath);
    const excludedPaths = await matchPaths(
      config.excludeFiles as string | string[],
      workPath
    );

    for (let i = 0; i < excludedPaths.length; i++) {
      // whitelist includeFiles
      if (includedPaths.includes(excludedPaths[i])) {
        continue;
      }

      // whitelist handler
      if (excludedPaths[i] === `${handlerRbFilename}.rb`) {
        continue;
      }

      // whitelist vendor directory
      if (excludedPaths[i].startsWith(vendorPath)) {
        continue;
      }

      delete outputFiles[excludedPaths[i]];
    }
  }

  const lambda = await createLambda({
    files: outputFiles,
    handler: `${handlerRbFilename}.vc__handler`,
    runtime,
    environment: {},
  });

  return { output: lambda };
}

// const TMP = tmpdir();

export async function startDevServer(
  opts: StartDevServerOptions
): Promise<StartDevServerResult> {
  const mm: Record<string, number> = {};
  const measure = (start: string, end?: string) => {
    const now = performance.now();
    if (end && mm[start]) {
      console.log(`MEASURE ${start}-${end}: ${now - mm[start]}ms`);
      mm[end] = now;
    } else mm[start] = now;
  };

  measure('start');

  const { entrypoint, workPath, meta = {} } = opts;
  // const { devCacheDir = join(workPath, '.vercel', 'cache') } = meta;
  // const entrypointDir = dirname(entrypoint);

  // For some reason, if `entrypoint` is a path segment (filename contains `[]`
  // brackets) then the `.rb` suffix on the entrypoint is missing. Fix that here…
  // let entrypointWithExt = entrypoint;
  // if (!entrypoint.endsWith('.rb')) {
  //   entrypointWithExt += '.rb';
  // }

  const entrypointAbsolute = join(workPath, entrypoint);

  const devServerRbPath = join(__dirname, '..', 'dev_server.rb');

  // const originalRbPath = join(__dirname, '..', 'vc_init.rb');
  // const originalHandlerRbContents = await readFile(originalRbPath, 'utf8');

  // const userHandlerFilePath = entrypoint.replace(/\.rb$/, '');
  // const nowHandlerRbContents = originalHandlerRbContents.replace(
  //   /__VC_HANDLER_FILENAME/g,
  //   userHandlerFilePath
  // );

  // // in order to allow the user to have `server.rb`, we need our `server.rb` to be called
  // // somethig else
  // const handlerRbFilename = 'vc__handler__ruby';

  // await writeFile(
  //   join(workPath, `${handlerRbFilename}.rb`),
  //   nowHandlerRbContents
  // );

  // const tmp = join(
  //   devCacheDir,
  //   'ruby',
  //   Math.random().toString(32).substring(2)
  // );
  // const tmpPackage = join(tmp, entrypointDir);
  // await mkdirp(tmpPackage);

  // await Promise.all([
  //   copyEntrypoint(entrypointWithExt, tmpPackage),
  //   copyDevServer(analyzed.functionName, tmpPackage),
  // ]);

  // const portFile = join(
  //   TMP,
  //   `vercel-dev-port-${Math.random().toString(32).substring(2)}`
  // );

  const env: typeof process.env = {
    ...process.env,
    ...meta.env,
    // VERCEL_DEV_PORT_FILE: portFile,
    VERCEL_DEV_HANDLER_FILE: entrypointAbsolute,
  };

  // const tmpRelative = `.${sep}${entrypointDir}`;
  const child = spawn('bundle', ['exec', 'ruby', devServerRbPath], {
    cwd: workPath,
    env,
    // TODO: get port from here??? RubyVM reserves FDs 4,5,6
    stdio: ['inherit', 'pipe', 'inherit', 'pipe'],
  });

  // child.once('exit', () => {
  //   retry(() => remove(tmp)).catch((err: Error) => {
  //     console.error('Could not delete tmp directory: %j: %s', tmp, err);
  //   });
  // });

  measure('start', 'spawned');

  const portPipe = child.stdout;
  if (!isReadable(portPipe)) {
    throw new Error('File descriptor 1 is not readable');
  }

  // `dev_server.rb` writes to stdout to be consumed here
  let first = true;
  const onPort = new Promise<PortInfo>(resolve => {
    portPipe.setEncoding('utf8');
    portPipe.on('data', d => {
      if (first) {
        const str = d
          .toString()
          .trim()
          .match(/RUBY_DEV_SERVER_PORT=(\d+)/)?.[1];
        const port = str && Number(str);
        measure('start', 'portPipe');
        resolve({ port });
        first = false;
      } else {
        process.stdout.write(d);
      }
    });
  });
  // const onPortFile = waitForPortFile(portFile);
  const onExit = once.spread<[number, string | null]>(child, 'exit');
  const result = await Promise.race([onPort, onExit]);
  onExit.cancel();
  // onPortFile.cancel();

  measure('start', 'end');

  if (isPortInfo(result)) {
    return {
      port: result.port,
      pid: child.pid,
    };
  } else if (Array.isArray(result)) {
    // Got "exit" event from child process
    const [exitCode, signal] = result;
    const reason = signal ? `"${signal}" signal` : `exit code ${exitCode}`;
    throw new Error(
      `\`bundle exec ruby ${devServerRbPath}\` failed with ${reason}`
    );
  } else {
    console.log({ result });
    throw new Error(`Unexpected result type: ${typeof result}`);
  }
}

interface PortInfo {
  port: number;
}

function isPortInfo(v: any): v is PortInfo {
  return v && typeof v.port === 'number';
}

function isReadable(v: any): v is Readable {
  return v && v.readable === true;
}

// TODO
// async function retry<T>(fn: () => Promise<T>): Promise<T> {
//   return fn();
// }

// export interface CancelablePromise<T> extends Promise<T> {
//   cancel: () => void;
// }

// function waitForPortFile(portFile: string) {
//   const opts = { portFile, canceled: false };
//   const promise = waitForPortFile_(opts) as CancelablePromise<PortInfo | void>;
//   promise.cancel = () => {
//     opts.canceled = true;
//   };
//   return promise;
// }

// async function waitForPortFile_(opts: {
//   portFile: string;
//   canceled: boolean;
// }): Promise<PortInfo | void> {
//   while (!opts.canceled) {
//     await new Promise(resolve => setTimeout(resolve, 100));
//     try {
//       const port = Number(await readFile(opts.portFile, 'ascii'));
//       retry(() => remove(opts.portFile)).catch((err: Error) => {
//         console.error('Could not delete port file: %j: %s', opts.portFile, err);
//       });
//       return { port };
//     } catch (err) {
//       if (err.code !== 'ENOENT') {
//         throw err;
//       }
//     }
//   }
// }
