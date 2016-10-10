import fs from 'fs-extra-promise';
import Path from 'path';
import readdirp from 'readdirp';
import { Observable } from 'rxjs';
import { createLogScan } from './util/log';
import { formatDevNameVersion } from './util/format';

const ENDS_NODE_MOD_RE = /[\\\/]node_modules$/;

/*
   Special directory tree filter for finding node_module/X packages
   - no dirs starting with '.'
   - accept node_modules
   - if under ancestor of node_modules
   - allow if parent is node_modules (keep in node_modules/X tree)
   - otherwise allow (not yet found node_modules tree)
 */
function filterDirsNodeModPacks(ei) {
  const eiName = ei.name;
  if (eiName.charAt(0) === '.') { return false; } // no dot dirs
  if (eiName === 'node_modules') { return true; } // node_modules
  const eiFullParentDir = ei.fullParentDir;
  if (eiFullParentDir.indexOf('node_modules') !== -1) { // under node_modules
    // only if grand parent is node_modules will we continue down
    return (Path.basename(eiFullParentDir) === 'node_modules');
  }
  return true; // not in node_modules yet, so keep walking
}

export default function findPackagesGrouped(config, rtenv, rootDirs) { // ret obs of ei
  const logScan = createLogScan(config, rtenv);

  return Observable.from(rootDirs)
  // find all package.json files
                   .mergeMap(
                     startDir => {
                       const readdirpOptions = {
                         root: startDir,
                         entryType: 'files',
                         lstat: true,  // want actual files not symlinked
                         fileFilter: ['package.json'],
                         directoryFilter: filterDirsNodeModPacks
                       };
                       if (config.treeDepth) { readdirpOptions.depth = config.treeDepth; }
                       const fstream = readdirp(readdirpOptions);
                       rtenv.cancelled$.subscribe(() => fstream.destroy()); // stop reading
                       return Observable.fromEvent(fstream, 'data')
                                        .takeWhile(() => !rtenv.cancelled)
                                        .takeUntil(Observable.fromEvent(fstream, 'close'))
                                        .takeUntil(Observable.fromEvent(fstream, 'end'));
                     },
                     config.concurrentOps
                   )
  // only parents ending in node_modules
                   .filter(ei => ENDS_NODE_MOD_RE.test(Path.dirname(ei.fullParentDir))
                   )
  // get name and version from package.json
                   .mergeMap(
                     ei => Observable.from(fs.readJsonAsync(ei.fullPath, { throws: false })),
                     (ei, pack) => ({ // returns eiDN
                       entryInfo: ei,
                                      devNameVer: (pack && pack.name && pack.version) ?
                                                  formatDevNameVersion(ei.stat.dev, pack.name, pack.version) :
                                                  null
                     }),
                     config.concurrentOps
                   )
                   .filter(obj => obj.devNameVer) // has name and version, not null
                   .do(obj => { rtenv.packageCount += 1; })
                   .do(obj => logScan(rtenv.packageCount, obj))
                   .groupBy(eiDN => eiDN.devNameVer)
                   .mergeMap(group => {
                     return group.reduce((acc, eiDN) => {
                       acc.push(eiDN.entryInfo);
                       return acc;
                     }, [])
                                 .map(arrEI => [group.key, arrEI]); // [devNameVer, arrPackEI]
                   });

}