import path from 'path';
import assert from 'assert';
import vanillaGlob_ from 'glob';
import { promisify } from 'util';
import { lstat, Stats } from 'fs-extra';
import FileFsRef from '../file-fs-ref';

export type GlobOptions = vanillaGlob_.IOptions;

interface FsFiles {
  [filePath: string]: FileFsRef;
}

const vanillaGlob = promisify(vanillaGlob_);

export default async function glob(
  pattern: string,
  opts: GlobOptions | string,
  mountpoint?: string
): Promise<FsFiles> {
  let options: GlobOptions;
  if (typeof opts === 'string') {
    options = { cwd: opts };
  } else {
    options = opts;
  }

  if (!options.cwd) {
    throw new Error(
      'Second argument (basePath) must be specified for names of resulting files'
    );
  }

  if (!path.isAbsolute(options.cwd)) {
    throw new Error(`basePath/cwd must be an absolute path (${options.cwd})`);
  }

  const results: FsFiles = {};

  options.symlinks = {};
  options.statCache = {};
  options.stat = true;
  options.dot = true;

  const files = await vanillaGlob(pattern, options);

  for (const relativePath of files) {
    const fsPath = path.join(options.cwd!, relativePath).replace(/\\/g, '/');
    let stat: Stats = options.statCache![fsPath] as Stats;
    assert(
      stat,
      `statCache does not contain value for ${relativePath} (resolved to ${fsPath})`
    );
    const isSymlink = options.symlinks![fsPath];
    if (isSymlink || stat.isFile()) {
      if (isSymlink) {
        stat = await lstat(fsPath);
      }

      let finalPath = relativePath;
      if (mountpoint) {
        finalPath = path.join(mountpoint, finalPath);
      }

      results[finalPath.replace(/\\/g, '/')] = new FileFsRef({ mode: stat.mode, fsPath });
    }
  }

  return results;
}
