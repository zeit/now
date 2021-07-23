import chalk from 'chalk';
import table from 'text-table';
import mri from 'mri';
import ms from 'ms';
import strlen from '../util/strlen.ts';
import { handleError, error } from '../util/error';
import NowSecrets from '../util/secrets';
import exit from '../util/exit';
import logo from '../util/output/logo';
import getScope from '../util/get-scope.ts';
import confirm from '../util/input/confirm';
import getCommandFlags from '../util/get-command-flags';
import getPrefixedFlags from '../util/get-prefixed-flags';
import { getPkgName, getCommandName } from '../util/pkg-name.ts';

const help = () => {
  console.log(`
  ${chalk.yellow(`DEPRECATED: Please use ${getPkgName()} env instead.`)}
  ${chalk.bold(`${logo} ${getPkgName()} secrets`)} [options] <command>

  ${chalk.dim('Commands:')}

    ls                               Show all secrets in a list
    add      [name] [value]          Add a new secret
    rename   [old-name] [new-name]   Change the name of a secret
    rm       [name]                  Remove a secret

  ${chalk.dim('Options:')}

    -h, --help                     Output usage information
    -A ${chalk.bold.underline('FILE')}, --local-config=${chalk.bold.underline(
    'FILE'
  )}   Path to the local ${'`vercel.json`'} file
    -Q ${chalk.bold.underline('DIR')}, --global-config=${chalk.bold.underline(
    'DIR'
  )}    Path to the global ${'`.vercel`'} directory
    -d, --debug                    Debug mode [off]
    -t ${chalk.bold.underline('TOKEN')}, --token=${chalk.bold.underline(
    'TOKEN'
  )}        Login token
    -S, --scope                    Set a custom scope
    -N, --next                     Show next page of results

  ${chalk.dim('Examples:')}

  ${chalk.gray('–')} Add a new secret

    ${chalk.cyan(`$ ${getPkgName()} secrets add my-secret "my value"`)}

    ${chalk.gray(
      '–'
    )} Once added, a secret's value can't be retrieved in plain text anymore
    ${chalk.gray(
      '–'
    )} If the secret's value is more than one word, wrap it in quotes
    ${chalk.gray('–')} When in doubt, always wrap your value in quotes

  ${chalk.gray(
    '–'
  )} Expose a secret as an environment variable (notice the ${chalk.cyan.bold(
    '`@`'
  )} symbol)

    ${chalk.cyan(`$ ${getPkgName()} -e MY_SECRET=${chalk.bold('@my-secret')}`)}

  ${chalk.gray('–')} Paginate results, where ${chalk.dim(
    '`1584722256178`'
  )} is the time in milliseconds since the UNIX epoch.

    ${chalk.cyan(`$ ${getPkgName()} secrets ls --next 1584722256178`)}
`);
};

// Options
let argv;
let debug;
let apiUrl;
let subcommand;
let nextTimestamp;

const main = async client => {
  argv = mri(client.argv.slice(2), {
    boolean: ['help', 'debug', 'yes'],
    alias: {
      help: 'h',
      debug: 'd',
      yes: 'y',
      next: 'N',
    },
  });

  argv._ = argv._.slice(1);

  debug = argv.debug;
  apiUrl = client.apiUrl;
  subcommand = argv._[0];
  nextTimestamp = argv.next;

  if (argv.help || !subcommand) {
    help();
    await exit(0);
  }

  const {
    authConfig: { token },
    output,
    config: { currentTeam },
  } = client;
  let contextName = null;

  try {
    ({ contextName } = await getScope(client));
  } catch (err) {
    if (err.code === 'NOT_AUTHORIZED' || err.code === 'TEAM_DELETED') {
      output.error(err.message);
      return 1;
    }

    throw err;
  }

  return run({ output, token, contextName, currentTeam, client });
};

export default async client => {
  try {
    await main(client);
  } catch (err) {
    handleError(err);
    process.exit(1);
  }
};

async function run({ output, token, contextName, currentTeam, client }) {
  const secrets = new NowSecrets({ apiUrl, token, debug, currentTeam, output });
  const args = argv._.slice(1);
  const start = Date.now();
  const { 'test-warning': testWarningFlag } = argv;
  const commandName = getCommandName('secret ' + subcommand);

  if (subcommand === 'ls' || subcommand === 'list') {
    output.warn(
      `${commandName} is deprecated. Please use ${getCommandName(
        'env ls'
      )} instead.`
    );
    if (args.length > 1) {
      console.error(
        error(
          `Invalid number of arguments. Usage: ${chalk.cyan(
            `${getCommandName('secret ls')}`
          )}`
        )
      );
      return 1;
    }

    const { secrets: list, pagination } = await secrets.ls(
      nextTimestamp,
      testWarningFlag
    );
    const elapsed = ms(Date.now() - start);

    console.log(
      `${list.length > 0 ? 'Secrets' : 'No secrets'} found under ${chalk.bold(
        contextName
      )} ${chalk.gray(`[${elapsed}]`)}`
    );

    if (list.length > 0) {
      const cur = Date.now();
      const header = [['', 'name', 'created'].map(s => chalk.dim(s))];
      const out = table(
        header.concat(
          list.map(secret => [
            '',
            chalk.bold(secret.name),
            chalk.gray(`${ms(cur - new Date(secret.created))} ago`),
          ])
        ),
        {
          align: ['l', 'l', 'l'],
          hsep: ' '.repeat(2),
          stringLength: strlen,
        }
      );

      if (out) {
        console.log(`\n${out}\n`);
      }
    }

    if (pagination && pagination.count === 20) {
      const prefixedArgs = getPrefixedFlags(argv);
      const flags = getCommandFlags(prefixedArgs, [
        '_',
        '--next',
        '-N',
        '-d',
        '-y',
      ]);
      const nextCmd = `secrets ${subcommand}${flags} --next ${pagination.next}`;
      output.log(`To display the next page run ${getCommandName(nextCmd)}`);
    }
    return secrets.close();
  }

  if (subcommand === 'rm' || subcommand === 'remove') {
    output.warn(
      `${commandName} is deprecated. Please use ${getCommandName(
        'env rm'
      )} instead.`
    );
    if (args.length !== 1) {
      console.error(
        error(
          `Invalid number of arguments. Usage: ${chalk.cyan(
            `${getCommandName('secret rm <name>')}`
          )}`
        )
      );
      return 1;
    }

    const theSecret = await secrets.getSecretByNameOrId(args[0]);

    if (theSecret) {
      const yes =
        argv.yes || (await readConfirmation(output, theSecret, contextName));
      if (!yes) {
        output.print(`Aborted. Secret not deleted.\n`);
        return 0;
      }
    } else {
      console.error(
        error(
          `No secret found by name "${args[0]}" under ${chalk.bold(
            contextName
          )}`
        )
      );
      return 1;
    }

    const secret = await secrets.rm(args[0]);
    const elapsed = ms(new Date() - start);
    console.log(
      `${chalk.cyan('Success!')} Secret ${chalk.bold(
        secret.name
      )} under ${chalk.bold(contextName)} removed ${chalk.gray(`[${elapsed}]`)}`
    );
    return secrets.close();
  }

  if (subcommand === 'rename') {
    output.warn(
      `${commandName} is deprecated. Please use ${getCommandName(
        'env rm'
      )} and ${getCommandName('env add')} instead.`
    );
    if (args.length !== 2) {
      console.error(
        error(
          `Invalid number of arguments. Usage: ${chalk.cyan(
            `${getCommandName('secret rename <old-name> <new-name>')}`
          )}`
        )
      );
      return 1;
    }
    const secret = await secrets.rename(args[0], args[1]);
    const elapsed = ms(new Date() - start);
    console.log(
      `${chalk.cyan('Success!')} Secret ${chalk.bold(
        secret.oldName
      )} renamed to ${chalk.bold(args[1])} under ${chalk.bold(
        contextName
      )} ${chalk.gray(`[${elapsed}]`)}`
    );
    return secrets.close();
  }

  if (subcommand === 'add' || subcommand === 'set') {
    output.warn(
      `${commandName} is deprecated. Please use ${getCommandName(
        'env add'
      )} instead.`
    );
    if (args.length !== 2) {
      console.error(
        error(
          `Invalid number of arguments. Usage: ${chalk.cyan(
            `${getCommandName('secret add <name> <value>')}`
          )}`
        )
      );

      if (args.length > 2) {
        const example = chalk.cyan(
          `$ ${getCommandName('secret add -- "${args[0]}"')}`
        );
        console.log(
          `If your secret has spaces or starts with '-', make sure to terminate command options with double dash and wrap it in quotes. Example: \n  ${example} `
        );
      }

      return 1;
    }

    const [name, parsedValue] = args;
    const [originalName, originalValue] = client.argv.slice(-2);

    let value = parsedValue;
    if (
      name === originalName &&
      typeof parsedValue === 'boolean' &&
      parsedValue !== originalValue
    ) {
      // Corner case where `mri` transforms the secret value into a boolean because
      // it starts with a `-` so it thinks its a flag, so we use the original value instead.
      value = originalValue;
    }

    if (typeof value === 'boolean') {
      const example = chalk.cyan(
        `$ ${getCommandName('secret add -- "${name}"')}`
      );
      console.log(
        `If your secret starts with '-', make sure to terminate command options with double dash and wrap it in quotes. Example: \n  ${example} `
      );
      return 1;
    }

    await secrets.add(name, value);
    const elapsed = ms(new Date() - start);

    if (name !== name.toLowerCase()) {
      output.warn(`Your secret name was converted to lower-case`);
    }

    console.log(
      `${chalk.cyan('Success!')} Secret ${chalk.bold(
        name.toLowerCase()
      )} added under ${chalk.bold(contextName)} ${chalk.gray(`[${elapsed}]`)}`
    );
    return secrets.close();
  }

  console.error(
    error('Please specify a valid subcommand: ls | add | rename | rm')
  );
  help();
  return 2;
}

async function readConfirmation(output, secret, contextName) {
  const time = chalk.gray(`${ms(new Date() - new Date(secret.created))} ago`);
  const tbl = table([[chalk.bold(secret.name), time]], {
    align: ['r', 'l'],
    hsep: ' '.repeat(6),
  });

  output.print(
    `The following secret will be removed permanently from ${chalk.bold(
      contextName
    )}\n`
  );
  output.print(`  ${tbl}\n`);

  return confirm(`${chalk.bold.red('Are you sure?')}`, false);
}
