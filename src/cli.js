import 'node-sigint';  // enable SIGINT on windows
import chalk from 'chalk';
import fs from 'fs-extra-promise';
import hideCursor from 'hide-terminal-cursor';
import Joi from 'joi';
import minimist from 'minimist';
import OS from 'os';
import Path from 'path';
import R from 'ramda';
import { Observable, ReplaySubject, Subject } from 'rxjs';
import showCursor from 'show-terminal-cursor';
import SingleLineLog from 'single-line-log';
import stripAnsi from 'strip-ansi';
import { formatBytes, sortObjKeys } from './util/format';
import { safeJsonReadSync, outputFileStderrSync } from './util/file';
import defaultRTEnv from './run-env-defaults';
import { prune, scanAndLink } from './index';

const isTTY = process.stdout.isTTY; // truthy if in terminal
const singleLineLog = SingleLineLog.stderr;

const DEFAULT_CONFIG_FILE = '.pkglink'; // in home directory
const DEFAULT_REFS_FILE = '.pkglink_refs'; // in home directory
const rtenv = { // create our copy
  ...defaultRTEnv
};

const minimistOpts = {
  boolean: ['d', 'g', 'h', 'p'],
  string: ['c', 'r'],
  alias: {
    c: 'config',
    d: 'dryrun',
    g: 'gen-ln-cmds',
    h: 'help',
    p: 'prune',
    r: 'refs-file',
    s: 'size',
    t: 'tree-depth'
  }
};
const argv = minimist(process.argv.slice(2), minimistOpts);

const argvSchema = Joi.object({
  config: Joi.string(),
  'refs-file': Joi.string(),
  size: Joi.number().integer().min(0),
  'tree-depth': Joi.number().integer().min(0)
})
                      .unknown();


const argvVResult = Joi.validate(argv, argvSchema);
if (argvVResult.error) {
  displayHelp();
  console.error('');
  console.error(chalk.red('error: invalid argument specified'));
  argvVResult.error.details.forEach(err => {
    console.error(err.message);
  });
  process.exit(20);
}

// should we be using terminal output
const isTermOut = isTTY && !argv['gen-ln-cmds'];

const CONFIG_PATH = argv.config ||
                    Path.resolve(process.env.HOME, DEFAULT_CONFIG_FILE);
const parsedConfigJson = safeJsonReadSync(CONFIG_PATH);
if (parsedConfigJson instanceof Error) {
  console.error(chalk.red('error: invalid JSON configuration'));
  console.error(`${chalk.bold('config file:')} ${CONFIG_PATH}`);
  console.error(parsedConfigJson); // error
  process.exit(21);
}
const unvalidatedConfig = parsedConfigJson || {};

const configSchema = Joi.object({
  refsFile: Joi.string().default(
    Path.resolve(process.env.HOME, DEFAULT_REFS_FILE)),
  concurrentOps: Joi.number().integer().min(1).default(4),
  minSize: Joi.number().integer().min(0).default(0),
  treeDepth: Joi.number().integer().min(0).default(0),
  consoleWidth: Joi.number().integer().min(30).default(70)
});

const configResult = Joi.validate(unvalidatedConfig, configSchema, { abortEarly: false });
if (configResult.error) {
  console.error(chalk.red('error: invalid JSON configuration'));
  console.error(`${chalk.bold('config file:')} ${CONFIG_PATH}`);
  configResult.error.details.forEach(err => {
    console.error(err.message);
  });
  process.exit(22);
}
const config = configResult.value; // with defaults applied
R.toPairs({ // for these defined argv values override config
  minSize: argv.size,
            treeDepth: argv['tree-depth']
}).forEach(p => {
  const k = p[0];
  const v = p[1];
  if (!R.isNil(v)) { // if defined, use it
    config[k] = v;
  }
});

const REFS_PATH = Path.resolve(argv['refs-file'] || config.refsFile);
rtenv.CONC_OPS = config.concurrentOps; // concurrent operations in mergeMap, default 4
rtenv.MIN_SIZE = config.minSize; // minimum size before sharing, default 0
rtenv.TREE_DEPTH = config.treeDepth; // depth to find mods, def 0 unlim
rtenv.EXTRACOLS = config.consoleWidth - 20;

if (argv.help || (!argv._.length && !argv.prune)) { // display help
  displayHelp();
  process.exit(23);
}

function displayHelp() {
  outputFileStderrSync(Path.join(__dirname, '..', 'usage.txt'));
}

fs.ensureFileSync(REFS_PATH);

const startingDirs = argv._.map(x => Path.resolve(x));

// key=nameVersion value: array of ref tuples [modPath, packJsonInode, packJsonMTimeEpoch]
rtenv.existingShares = fs.readJsonSync(REFS_PATH, { throws: false }) || {};
const origExistingShares = rtenv.existingShares; // keep ref copy


rtenv.cancelled$ = new ReplaySubject();

const singleLineLog$ = new Subject();
singleLineLog$
  .filter(x => isTermOut) // only if in terminal
  .distinct()
  .throttleTime(10)
  .takeUntil(rtenv.cancelled$)
  .subscribe({
    next: x => singleLineLog(x),
    complete: () => {
      singleLineLog('');
      singleLineLog.clear();
    }
  });
const log = singleLineLog$.next.bind(singleLineLog$);
log.clear = () => {
  if (isTermOut) {
    singleLineLog('');
    singleLineLog.clear();
  }
};
rtenv.log = log; // share this logger in the rtenv

function out(str) {
  const s = (isTermOut) ? str : stripAnsi(str);
  process.stdout.write(s);
  process.stdout.write(OS.EOL);
}
rtenv.out = out; // share this output fn in the rtenv

const cancel = R.once(() => {
  rtenv.cancelled = true;
  rtenv.cancelled$.next(true);
  console.error('cancelling and saving state...');
  if (isTermOut) { showCursor(); }
});
const finalTasks = R.once(() => {
  singleLineLog$.complete();
  if (isTermOut) { showCursor(); }
  if (argv.dryrun || argv['gen-ln-cmds']) {
    out(`# ${chalk.yellow('would save:')} ${chalk.bold(formatBytes(rtenv.savedByteCount))}`);
    return;
  }
  if (rtenv.existingShares !== origExistingShares) {
    const sortedExistingShares = sortObjKeys(rtenv.existingShares);
    fs.outputJsonSync(REFS_PATH, sortedExistingShares);
    out(`updated ${REFS_PATH}`);
  }
  if (rtenv.savedByteCount) {
    out(`${chalk.green('saved:')} ${chalk.bold(formatBytes(rtenv.savedByteCount))}`);
  }
});

process
  .once('SIGINT', cancel)
  .once('SIGTERM', cancel)
  .once('EXIT', finalTasks);

if (isTermOut) { hideCursor(); } // show on exit
out(''); // advance to full line

// Main program start, create task$ and run
const arrTaskObs = [];
if (argv.prune) {
  arrTaskObs.push(
    Observable.of('pruning')
              .do(() => log(`${chalk.bold('pruning...')}`))
              .mergeMap(() => prune(rtenv.existingShares, rtenv)
                .do(newShares => { rtenv.existingShares = newShares; }))
  );
}
if (startingDirs.length) {
  arrTaskObs.push(scanAndLink(startingDirs, argv, rtenv));
}

// run all the task observables serially
if (arrTaskObs.length) {
  Observable.concat(...arrTaskObs)
            .subscribe({
              error: err => console.error(err),
              complete: () => finalTasks()
            });
}