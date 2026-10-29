"""Copied into TEMP fixture resources only; never a production resource glob."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import uvicorn
import product_server as server
from fastapi.responses import HTMLResponse
from generation_jobs import GenerationJob
from update_service import atomic_json, sha256

ROOT = Path(__file__).resolve().parents[3]
assert (ROOT / 'fixture-owner').is_file()
assert os.environ['STEPPE_DATA_DIR'] == str(ROOT / 'data')
job_id = 'a' * 32

@server.app.post('/api/v1/system/updates/fixture/{action}')
async def fixture(action: str):
    updater = server.updater
    if action == 'seed':
        directory = updater.root / job_id
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(updater.root, 0o700)
        shutil.copy2(ROOT / 'candidate.dmg', directory / 'ready.dmg')
        pin = dict(version=json.loads((ROOT/'candidate.json').read_text())['version'],
                   channel=updater.channel(), digest=sha256(directory/'ready.dmg'), size=(directory/'ready.dmg').stat().st_size)
        atomic_json(directory/'pin.json', pin)
        updater.job = dict(stage='ready', job_id=job_id, selection_id='fixture', version=pin['version'],
                           cancellable=True, autoEligible=True, error=None)
        updater.persist()
    elif action == 'generation':
        task = asyncio.create_task(asyncio.Event().wait())
        server.generation_jobs.jobs['fixture'] = GenerationJob('fixture', task=task)
    elif action == 'clear':
        job = server.generation_jobs.jobs.pop('fixture', None)
        if job:
            job.task.cancel()
            await asyncio.gather(job.task, return_exceptions=True)
    elif action == 'browserdenied':
        atomic_json(ROOT/'browser-denied.json', {'passed': True, 'origin': 'http-loopback'})
    elif action == 'readonly':
        os.chmod(ROOT, 0o500)
    elif action == 'writable':
        os.chmod(ROOT, 0o700)
    elif action == 'recover':
        from update_installer import helper_active, read_json
        for _ in range(100):
            if not helper_active(updater.root/job_id, read_json(updater.root/job_id/'transaction.json')):
                break
            await asyncio.sleep(.1)
        state = updater.state()
        assert state['stage'] == 'completed'
        state.update(stage='recovery_required', retry=True)
        atomic_json(updater.root/job_id/'state.json', state)
        updater.job = state
    else:
        raise ValueError('unknown fixture action')
    return {'ok': True}

@server.app.get('/fixture-origin')
async def browser_origin():
    return HTMLResponse("""<!doctype html><title>Isolated browser origin denial</title><script>
(async()=>{
 let denied=false;
 try {
   if(!window.__TAURI_INTERNALS__) denied=true;
   else await window.__TAURI_INTERNALS__.invoke('install_update',{jobId:'a'.repeat(32)});
 } catch {denied=true;}
 if(!denied) return;
 await fetch('/api/v1/system/updates/fixture/browserdenied',{method:'POST'});
 location.replace('tauri://localhost/index.html?originchecked=1');
})();
</script>""")

uvicorn.run(server.app, host='127.0.0.1', port=int(os.environ['DESKTOP_API_PORT']))
