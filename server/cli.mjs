import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadRuntime } from './config.mjs';
import { openStore } from './store.mjs';
import { createRunner } from './runner.mjs';
import { createSocialDataAdapter } from './adapters/socialdata.mjs';
import { createScraperTechAdapter } from './adapters/scrapertech.mjs';
import { createModelAdapter } from './adapters/model.mjs';
import { createTelegramAdapter } from './adapters/telegram.mjs';

const command=process.argv[2];
const configDir=path.resolve(process.cwd(),'config','local');
const commands=new Set(['check','once','start','status','decisions']);
const log=(data)=>console.log(JSON.stringify({at:new Date().toISOString(),...data}));
async function main() {
  if (!commands.has(command) || process.argv.length!==3) {
    console.error('Usage: node --env-file-if-exists=.env server/cli.mjs check|once|start|status|decisions');
    process.exitCode=2; return;
  }
  let config;
  try { config=loadRuntime(configDir); } catch (e) {
    console.error(e.message.startsWith('Invalid configuration:') || e.message.startsWith('Invalid policy:') ? e.message : 'Invalid ALPHA configuration.');
    process.exitCode=2; return;
  }
  if (command==='check') {
    log({configuration:'ok',accounts:config.watch.length,lists:config.lists.length,delivery:config.delivery.mode});
    return;
  }
  const previousMask=process.umask(0o077);
  let store; let timer; let wake;
  let stopping=false;
  const stop=()=>{stopping=true;clearTimeout(timer);wake?.();};
  try {
    mkdirSync(path.dirname(config.databasePath),{recursive:true,mode:0o700});
    store=openStore(config.databasePath);
    if (command==='status') { log({status:store.status()});return; }
    if (command==='decisions') { log({decisions:store.recentDecisions()});return; }
    process.once('SIGINT',stop); process.once('SIGTERM',stop);
    const runner=createRunner(config, {
      store,
      socialdata: config.socialdata.apiKey ? createSocialDataAdapter(config.socialdata) : null,
      scrapertech: config.scrapertech.apiKey ? createScraperTechAdapter(config.scrapertech) : null,
      model: createModelAdapter(config.model),
      telegram: config.delivery.mode==='telegram' ? createTelegramAdapter(config.delivery) : null,
    });
    do {
      const cycle=await runner.runCycle();
      log({cycle,status:store.status()});
      if (command==='once') {
        if (cycle.sourceErrors || cycle.analysisErrors || cycle.deliveryErrors || cycle.partial) process.exitCode=1;
        break;
      }
      if (!stopping) await new Promise(resolve=>{wake=resolve;timer=setTimeout(resolve,config.pollSeconds*1000);});
    } while (!stopping);
  } catch (e) {
    console.error(e.code==='STORE_LOCKED' ? 'ALPHA data directory is locked. Stop the other process first.' : 'ALPHA stopped: local runtime error. Verify files, permissions and SQLite state.');
    process.exitCode=1;
  } finally {
    clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    try { store?.close(); } finally { process.umask(previousMask); }
  }
}
await main();
