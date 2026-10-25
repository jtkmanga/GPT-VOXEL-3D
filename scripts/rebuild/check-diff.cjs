'use strict';
// Check every rebuild change and untracked candidate, including before staging.
const {execFileSync,spawnSync}=require('node:child_process');
const git=args=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
try {
  git(['diff','--check','f98aa9a044616b1b965b889cf0c02a0d3b041f65']);
  git(['diff','--cached','--check']);
  const files=git(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
  for (const file of files) {
    const result=spawnSync('git',['diff','--no-index','--check','--','/dev/null',file],{encoding:'utf8'});
    // --no-index returns 1 for a new file even when --check reports no errors.
    if (result.error || ![0,1].includes(result.status) || (result.stdout+result.stderr).trim())
      throw Error(result.stdout+result.stderr || result.error?.message || `Diff failed: ${file}`);
  }
  console.log(`PASS complete rebuild diff and ${files.length} untracked candidate files`);
} catch(error) { console.error(error.stderr?.toString()||error.message);process.exitCode=1; }
